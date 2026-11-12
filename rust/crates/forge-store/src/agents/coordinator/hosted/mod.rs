use super::*;
use forge_core::agents::{
    routing,
    runtime::{self, Runtime as AgentRuntime},
};
use futures_util::Stream;
use std::pin::Pin;
mod stream;
mod transitions;
pub struct Hosted {
    pub models: Arc<model_connections::Service>,
    pub runtimes: Vec<Arc<dyn AgentRuntime>>,
    pub features: Value,
}
impl Hosted {
    pub fn new(
        models: Arc<model_connections::Service>,
        runtimes: Vec<Arc<dyn AgentRuntime>>,
    ) -> Self {
        Self {
            models,
            runtimes,
            features: policy::features(&Default::default()),
        }
    }
}
pub type EventStream = Pin<Box<dyn Stream<Item = Result<Event, StoreError>> + Send>>;
pub struct RunSession {
    pub run: Run,
    pub events: EventStream,
}
impl std::fmt::Debug for RunSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunSession")
            .field("run", &self.run)
            .finish_non_exhaustive()
    }
}
enum Mode {
    Start {
        message: String,
        attachments: Vec<Value>,
    },
    Resume(Vec<Value>),
}
struct Prepared {
    service: Service,
    actor: Actor,
    thread: Thread,
    run: Run,
    runtime: Arc<dyn AgentRuntime>,
    initial: Vec<Event>,
    mode: Mode,
    correlation: Option<String>,
    epoch: i32,
}
impl Service {
    fn hosted(&self) -> Result<&Hosted, StoreError> {
        self.hosted.as_deref().ok_or_else(unavailable)
    }
    fn runtime(&self, kind: Runtime) -> Result<Arc<dyn AgentRuntime>, StoreError> {
        self.hosted()?
            .runtimes
            .iter()
            .rev()
            .find(|r| r.kind() == runtime_name(kind))
            .cloned()
            .ok_or_else(unavailable)
    }
    fn route(&self, input: &Value, catalog: Vec<Value>) -> Result<Value, StoreError> {
        let hosted = self.hosted()?;
        if input["selectionMode"] == "auto" && hosted.features["agent_auto_openai"] != true {
            return Err(routing::RoutingError {
                code: "AUTO_UNAVAILABLE",
                message: "OpenAI Auto is not enabled for this deployment.".into(),
            }
            .into());
        }
        let catalog: Vec<_> = catalog
            .into_iter()
            .filter(|m| {
                let provider = m["provider"].as_str().unwrap_or("").to_lowercase();
                policy::provider_enabled(&hosted.features, &provider)
                    && self.controls["allowedProviders"]
                        .as_array()
                        .is_none_or(|p| p.iter().any(|p| p == &provider))
            })
            .collect();
        let mut request = json!({"mode":input["selectionMode"],"message":input["message"],"availableModels":catalog,"manualModel":input["model"],"reasoningEffort":input["reasoningEffort"],"preferredOpenAIConnectionId":input["preferredOpenAIConnectionId"]});
        let result = if self.loop_binding.is_some() {
            if input.get("reasoningEffort").is_none() {
                request.as_object_mut().unwrap().remove("reasoningEffort");
            }
            forge_core::loops::resolve_model(&request)?
        } else {
            routing::resolve(&request)?
        };
        // The connection's catalog is the provider authority. A client-supplied
        // reference cannot change which provider receives the run credential.
        if result["model"]["provider"] != result["route"]["provider"] {
            return Err(StoreError::InvalidInput);
        }
        Ok(result)
    }
    async fn route_with_refresh(&self, actor: &Actor, input: &Value) -> Result<(), StoreError> {
        let models = &self.hosted()?.models;
        let initial = self.route(input, models.catalog(actor, true).await?);
        if matches!(&initial,Err(StoreError::AgentRouting(e))if matches!(e.code,"MODEL_UNAVAILABLE"|"AUTO_UNAVAILABLE"))
        {
            models
                .refresh_for_routing(
                    actor,
                    if input["selectionMode"] == "manual" {
                        Some(parse_id(&input["model"]["connectionId"])?)
                    } else {
                        None
                    },
                )
                .await?;
            self.route(input, models.catalog(actor, true).await?)?;
        } else {
            initial?;
        }
        Ok(())
    }
    pub async fn start_turn(
        &self,
        actor: &Actor,
        input: Value,
        correlation: Option<String>,
    ) -> Result<RunSession, StoreError> {
        let (mut tx, actor) = self.begin(actor, ApiScope::AgentsWrite, false).await?;
        self.invoke(&mut tx, &actor).await?;
        let input = contracts::turn(input, false).map_err(|_| StoreError::InvalidInput)?;
        let id = parse_id(&input["threadId"])?;
        super::local::active_thread(&self.owned_thread(&mut tx, &actor, id, false).await?)?;
        self.budget(&mut tx, &actor).await?;
        tx.commit().await?;
        let ids: Vec<Uuid> = decode(input["attachmentIds"].clone())?;
        let attachments = self.resolve_attachments(&actor, &ids).await?;
        self.route_with_refresh(&actor, &input).await?;
        let (mut tx, actor) = self.begin(&actor, ApiScope::AgentsWrite, true).await?;
        self.invoke(&mut tx, &actor).await?;
        let mut thread = self.owned_thread(&mut tx, &actor, id, true).await?;
        super::local::active_thread(&thread)?;
        self.budget(&mut tx, &actor).await?;
        let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agent_runs WHERE thread_id=$1 AND state IN ('created','connecting','running','waiting-for-approval','reconnecting'))").bind(id).fetch_one(&mut *tx).await?;
        if active {
            return Err(StoreError::Conflict);
        }
        if !ids.is_empty() {
            let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM agent_attachments WHERE id=ANY($1) AND workspace_id=$2 AND user_id=$3 AND deleted_at IS NULL AND expires_at>$4").bind(&ids).bind(&actor.workspace_id).bind(&actor.user_id).bind(self.time()).fetch_one(&mut *tx).await?;
            if count as usize != ids.len() {
                return Err(StoreError::Conflict);
            }
        }
        let resolved = self.route(
            &input,
            self.hosted()?
                .models
                .catalog_in(&mut tx, &actor, true)
                .await?,
        )?;
        let runtime_kind: Runtime = decode(resolved["route"]["runtimeKind"].clone())?;
        let runtime = self.runtime(runtime_kind)?;
        self.preference_in(&mut tx,&actor,id,json!({"mode":input["selectionMode"],"selectedConnectionId":if input["selectionMode"]=="manual"{input["model"]["connectionId"].clone()}else{input["preferredOpenAIConnectionId"].clone()},"selectedModelId":if input["selectionMode"]=="manual"{input["model"]["modelId"].clone()}else{Value::Null},"selectedEffort":input["reasoningEffort"]})).await?;
        if thread.runtime_kind != runtime_kind {
            thread = threads::update_in(
                &mut tx,
                &actor.workspace_id,
                id,
                &ThreadPatch {
                    runtime_kind: Some(runtime_kind),
                    runtime_session_id: Some(None),
                    last_activity_at: Some(self.time()),
                    ..Default::default()
                },
            )
            .await?
            .ok_or_else(thread_missing)?;
        }
        let model = &resolved["model"];
        let run_id = self
            .loop_binding
            .as_ref()
            .map_or_else(Uuid::new_v4, |b| b.agent_run_id);
        if self.loop_binding.is_some()
            && runs::get_in(&mut tx, &actor.workspace_id, run_id)
                .await?
                .is_some()
        {
            return Err(StoreError::LoopPolicy("UNCERTAIN_DISPATCH"));
        }
        let mut selection = json!({"mode":input["selectionMode"],"selectionId":resolved["requestedSelection"],"provider":model["provider"],"billingMode":resolved["route"]["billingMode"]});
        if let Some(binding) = &self.loop_binding {
            selection["loopRunId"] = json!(binding.run_id);
        }
        let run = runs::create_in(
            &mut tx,
            &CreateRun {
                id: run_id,
                thread_id: id,
                initiated_by_user_id: actor.user_id.clone(),
                state: RunState::Created,
                execution_kind: decode(model["executionKind"].clone())?,
                requested_selection: selection,
                resolved_connection_id: Some(parse_id(&model["connectionId"])?),
                resolved_model_id: decode(model["modelId"].clone())?,
                reasoning_effort: decode(resolved["reasoningEffort"].clone())?,
                routing_policy_version: decode(resolved["routingPolicyVersion"].clone())?,
                routing_reason: decode(resolved["routingReason"].clone())?,
                runtime_run_id: None,
                input_tokens: 0,
                output_tokens: 0,
                cached_input_tokens: 0,
                cost_micros: 0,
                started_at: None,
                completed_at: None,
                error_code: None,
            },
        )
        .await?;
        let public_attachments: Vec<_> = attachments
            .iter()
            .cloned()
            .map(|mut a| {
                a.as_object_mut().unwrap().remove("contentBase64");
                a
            })
            .collect();
        let created=super::local::forge_event(&mut tx,&run,"created","run.created",self.time(),json!({"message":input["message"],"attachmentIds":input["attachmentIds"],"attachments":public_attachments})).await?;
        let routed = super::local::forge_event(
            &mut tx,
            &run,
            "routing-resolved",
            "run.routing-resolved",
            self.time(),
            resolved,
        )
        .await?;
        tx.commit().await?;
        Ok(RunSession {
            run: run.clone(),
            events: stream::open(Prepared {
                service: self.clone(),
                actor,
                thread,
                run,
                runtime,
                initial: vec![created, routed],
                mode: Mode::Start {
                    message: input["message"].as_str().unwrap().into(),
                    attachments,
                },
                correlation,
                epoch: 0,
            }),
        })
    }
}
fn runtime_name(kind: Runtime) -> &'static str {
    match kind {
        Runtime::Eve => "eve",
        Runtime::Codex => "codex",
        Runtime::Claude => "claude",
    }
}
fn unavailable() -> StoreError {
    error(
        "RUNTIME_UNAVAILABLE",
        "The selected agent runtime is unavailable.",
    )
}
