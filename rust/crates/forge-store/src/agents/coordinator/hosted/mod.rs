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
    async fn certified_input_continuation(
        &self,
        tx: &mut JournalTransaction,
        actor: &Actor,
        thread: &Thread,
        runtime: &dyn AgentRuntime,
        composer: bool,
    ) -> Result<Option<runtime::Continuation>, StoreError> {
        let Some(proof) = thread
            .runtime_session_id
            .as_deref()
            .and_then(|c| runtime.input_continuation(c))
        else {
            return Ok(None);
        };
        let mut ended = true;
        for id in [&proof.head_run_id, &proof.owner_run_id] {
            let Ok(id) = Uuid::parse_str(id) else {
                return Ok(None);
            };
            let Some(run) = runs::get_in(tx, &actor.workspace_id, id).await? else {
                return Ok(None);
            };
            if run.thread_id != thread.id
                || run.initiated_by_user_id != actor.user_id
                || !matches!(
                    run.state,
                    RunState::Completed | RunState::WaitingForApproval
                ) && !(composer && terminal(run.state))
            {
                return Ok(None);
            }
            ended &= terminal(run.state);
        }
        if !proof.pending_inputs && !proof.delivery_complete && !(composer && ended) {
            return Ok(None);
        }
        let busy: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agent_runs WHERE thread_id=$1 AND state IN ('created','connecting','running','reconnecting'))")
            .bind(thread.id).fetch_one(&mut **tx).await?;
        Ok((!busy).then_some(proof))
    }
    async fn input_continuation_allowed(
        &self,
        tx: &mut JournalTransaction,
        actor: &Actor,
        thread: &Thread,
        runtime: &dyn AgentRuntime,
    ) -> Result<bool, StoreError> {
        if self
            .certified_input_continuation(tx, actor, thread, runtime, true)
            .await?
            .is_none()
        {
            return self
                .question_continuation_allowed(tx, actor, thread, runtime)
                .await;
        }
        // Canonical approvals remain bound to their original runs. A composer
        // delivery may queue or answer input, but cannot consume those grants.
        let waiting: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM agent_runs WHERE thread_id=$1 AND state='waiting-for-approval'",
        )
        .bind(thread.id)
        .fetch_all(&mut **tx)
        .await?;
        for id in waiting {
            let inputs: Vec<(String, String, String)> = sqlx::query_as("SELECT source,type,payload_json::text FROM agent_events WHERE run_id=$1 AND type IN ('run.waiting','approval.requested') AND sequence>COALESCE((SELECT MAX(sequence) FROM agent_events WHERE run_id=$1 AND type='approval.resolved'),0) ORDER BY sequence")
                .bind(id).fetch_all(&mut **tx).await?;
            if inputs.is_empty()
                || inputs.into_iter().any(|(source, kind, payload)| {
                    let Ok(payload) = forge_core::json::parse(&payload) else {
                        return true;
                    };
                    if source == "forge" && kind == "approval.requested" {
                        return payload["summary"]["details"]["runtimeRequestId"]
                            .as_str()
                            .is_none_or(|s| Uuid::parse_str(s).is_err());
                    }
                    if source != "eve"
                        || kind != "run.waiting"
                        || payload["reason"] != "input-required"
                    {
                        return true;
                    }
                    if payload["requestId"]
                        .as_str()
                        .is_some_and(|s| Uuid::parse_str(s).is_ok())
                    {
                        return false;
                    }
                    let request = &payload["request"];
                    request["kind"] != "question"
                        || request["action"]["toolName"] != "ask_question"
                        || !matches!(request["display"].as_str(), Some("text" | "select"))
                        || forge_core::agents::eve::normalize(
                            json!({"type":"input.requested","data":{"requests":[request]}}),
                            "input-admission",
                            None,
                        )
                        .is_err()
                })
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
    async fn question_continuation_allowed(
        &self,
        tx: &mut JournalTransaction,
        actor: &Actor,
        thread: &Thread,
        runtime: &dyn AgentRuntime,
    ) -> Result<bool, StoreError> {
        // Certification is written by the native adapter only after the entire
        // private waiting batch has drained. A first public question event alone
        // is insufficient: a later entry may still require human approval.
        let Some(cursor) = thread.runtime_session_id.as_deref() else {
            return Ok(false);
        };
        let Some(head) = runtime
            .cursor_run_id(cursor)
            .and_then(|run| Uuid::parse_str(&run).ok())
        else {
            return Ok(false);
        };
        let Some(head) = runs::get_in(tx, &actor.workspace_id, head).await? else {
            return Ok(false);
        };
        if head.thread_id != thread.id
            || head.initiated_by_user_id != actor.user_id
            || (!terminal(head.state) && head.state != RunState::WaitingForApproval)
            || runtime
                .question_continuation_run(cursor, terminal(head.state))
                .and_then(|run| Uuid::parse_str(&run).ok())
                != Some(head.id)
        {
            return Ok(false);
        }
        let required: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agent_approvals a JOIN agent_runs r ON r.id=a.run_id WHERE r.thread_id=$1 AND a.state IN ('pending','approved'))")
            .bind(thread.id).fetch_one(&mut **tx).await?;
        if required {
            return Ok(false);
        }
        let active: Vec<(Uuid, String)> = sqlx::query_as("SELECT id,state FROM agent_runs WHERE thread_id=$1 AND state IN ('created','connecting','running','waiting-for-approval','reconnecting')")
            .bind(thread.id).fetch_all(&mut **tx).await?;
        for (id, state) in active {
            if state != "waiting-for-approval" {
                return Ok(false);
            }
            // Earlier question runs intentionally remain waiting in the public
            // source model. They can coexist only behind the certified head.
            let inputs: Vec<(String, String, String)> = sqlx::query_as("SELECT source,type,payload_json::text FROM agent_events WHERE run_id=$1 AND type IN ('run.waiting','approval.requested') AND sequence>COALESCE((SELECT MAX(sequence) FROM agent_events WHERE run_id=$1 AND type='approval.resolved'),0) ORDER BY sequence")
                .bind(id).fetch_all(&mut **tx).await?;
            if inputs.is_empty()
                || inputs.into_iter().any(|(source, kind, payload)| {
                    if source != "eve" || kind != "run.waiting" {
                        return true;
                    }
                    let Ok(payload) = forge_core::json::parse(&payload) else {
                        return true;
                    };
                    let request = &payload["request"];
                    payload["reason"] != "input-required"
                        || request["kind"] != "question"
                        || request["action"]["toolName"] != "ask_question"
                        || !matches!(request["display"].as_str(), Some("text" | "select"))
                        || forge_core::agents::eve::normalize(
                            json!({"type":"input.requested","data":{"requests":[request]}}),
                            "question-admission",
                            None,
                        )
                        .is_err()
                })
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
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
        let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agent_runs WHERE thread_id=$1 AND state IN ('created','connecting','running','waiting-for-approval','reconnecting'))").bind(id).fetch_one(&mut *tx).await?;
        if active
            && (thread.runtime_kind != runtime_kind
                || !self
                    .input_continuation_allowed(&mut tx, &actor, &thread, runtime.as_ref())
                    .await?)
        {
            return Err(StoreError::Conflict);
        }
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
