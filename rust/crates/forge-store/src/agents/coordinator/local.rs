use super::*;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedLocal {
    pub run: Run,
    pub thread: Thread,
    pub initial_events: Vec<Event>,
    pub runtime_session_id: Option<String>,
    pub attachments: Vec<Value>,
}
impl Service {
    pub async fn prepare_local(
        &self,
        actor: &Actor,
        input: Value,
    ) -> Result<PreparedLocal, StoreError> {
        let (mut tx, actor) = self.begin(actor, ApiScope::AgentsWrite, false).await?;
        self.invoke(&mut tx, &actor).await?;
        let input = contracts::turn(input, true).map_err(|_| StoreError::InvalidInput)?;
        let id = parse_id(&input["threadId"])?;
        let thread = self.owned_thread(&mut tx, &actor, id, false).await?;
        active_thread(&thread)?;
        self.budget(&mut tx, &actor).await?;
        tx.commit().await?;
        let ids: Vec<Uuid> = decode(input["attachmentIds"].clone())?;
        let attachments = self.resolve_attachments(&actor, &ids).await?;
        let (mut tx, actor) = self.begin(&actor, ApiScope::AgentsWrite, true).await?;
        self.invoke(&mut tx, &actor).await?;
        let mut thread = self.owned_thread(&mut tx, &actor, id, true).await?;
        active_thread(&thread)?;
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
        let runtime: Runtime = decode(input["runtimeId"].clone())?;
        let model = &input["model"];
        let connection = self.local_connection(&mut tx, &actor, model).await?;
        self.preference_in(&mut tx,&actor,id,json!({"mode":"manual","selectedConnectionId":connection,"selectedModelId":model["modelId"],"selectedEffort":input["reasoningEffort"]})).await?;
        if thread.runtime_kind != runtime {
            thread = threads::update_in(
                &mut tx,
                &actor.workspace_id,
                id,
                &ThreadPatch {
                    runtime_kind: Some(runtime),
                    runtime_session_id: Some(None),
                    last_activity_at: Some(self.time()),
                    ..Default::default()
                },
            )
            .await?
            .ok_or_else(thread_missing)?;
        }
        let now = self.time();
        let run=runs::create_in(&mut tx,&CreateRun{id:Uuid::new_v4(),thread_id:id,initiated_by_user_id:actor.user_id.clone(),state:RunState::Running,execution_kind:Execution::ExternalAgent,requested_selection:json!({"mode":"manual","selectionId":model["selectionId"],"provider":model["provider"],"runtimeId":runtime,"billingMode":"subscription"}),resolved_connection_id:Some(connection),resolved_model_id:decode(model["modelId"].clone())?,reasoning_effort:decode(input["reasoningEffort"].clone())?,routing_policy_version:None,routing_reason:Some("The user selected a local subscription model.".into()),runtime_run_id:None,input_tokens:0,output_tokens:0,cached_input_tokens:0,cost_micros:0,started_at:Some(now),completed_at:None,error_code:None}).await?;
        let public_attachments: Vec<_> = attachments
            .iter()
            .cloned()
            .map(|mut a| {
                a.as_object_mut().unwrap().remove("contentBase64");
                a
            })
            .collect();
        let created=forge_event(&mut tx,&run,"created","run.created",now,json!({"message":input["message"],"attachmentIds":input["attachmentIds"],"attachments":public_attachments})).await?;
        let routed=forge_event(&mut tx,&run,"routing-resolved","run.routing-resolved",now,json!({"requestedSelection":model["selectionId"],"model":model,"reasoningEffort":input["reasoningEffort"],"routingPolicyVersion":null,"routingReason":"The user selected a local subscription model.","route":{"runtimeKind":runtime,"executionKind":model["executionKind"],"connectionId":model["connectionId"],"connectionLabel":if runtime==Runtime::Codex{"Codex subscription"}else{"Claude subscription"},"locality":"local-only","billingMode":"subscription","provider":model["provider"],"providerLabel":if model["provider"]=="openai"{json!("OpenAI")}else{model["provider"].clone()},"modelId":model["modelId"],"modelDisplayName":model["modelId"],"reasoningEffort":input["reasoningEffort"]}})).await?;
        let started = forge_event(&mut tx, &run, "started", "run.started", now, json!({})).await?;
        tx.commit().await?;
        Ok(PreparedLocal {
            runtime_session_id: thread.runtime_session_id.clone(),
            run,
            thread,
            initial_events: vec![created, routed, started],
            attachments,
        })
    }
    pub async fn checkpoint_local(
        &self,
        actor: &Actor,
        id: Uuid,
        input: Value,
    ) -> Result<(), StoreError> {
        let (mut tx, actor) = self.begin(actor, ApiScope::AgentsWrite, true).await?;
        let (thread, run) = self.owned_run(&mut tx, &actor, id, true).await?;
        local(&run)?;
        if terminal(run.state) {
            return Err(StoreError::Conflict);
        }
        let input = contracts::checkpoint(input).map_err(|_| StoreError::InvalidInput)?;
        runs::update_in(
            &mut tx,
            id,
            &RunPatch {
                runtime_run_id: Some(decode(input["runtimeRunId"].clone())?),
                ..Default::default()
            },
        )
        .await?;
        threads::update_in(
            &mut tx,
            &actor.workspace_id,
            thread.id,
            &ThreadPatch {
                runtime_session_id: Some(decode(input["runtimeSessionId"].clone())?),
                last_activity_at: Some(self.time()),
                ..Default::default()
            },
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn ingest_local(
        &self,
        actor: &Actor,
        id: Uuid,
        input: Value,
    ) -> Result<Vec<Event>, StoreError> {
        let (mut tx, actor) = self.begin(actor, ApiScope::AgentsWrite, true).await?;
        let (thread, mut run) = self.owned_run(&mut tx, &actor, id, true).await?;
        local(&run)?;
        let parsed = contracts::local_events(json!({"runId":id,"events":input}))
            .map_err(|_| StoreError::InvalidInput)?;
        let mut result = Vec::new();
        let mut changed = false;
        for event in parsed["events"].as_array().unwrap() {
            contracts::safe_payload(&event["payload"]).map_err(|_| StoreError::InvalidInput)?;
            if event["source"] != json!(thread.runtime_kind) {
                return Err(StoreError::Forbidden);
            }
            if event["type"] == "approval.resolved" {
                // Desktop acknowledgements cannot resolve the approval ledger or
                // move a terminal run back to running; resolution owns that state.
                let approval = approvals::get(&mut tx, parse_id(&event["payload"]["approvalId"])?)
                    .await?
                    .ok_or(StoreError::Forbidden)?;
                if approval.run_id != id
                    || approval.requested_for_user_id != actor.user_id
                    || !matches!(
                        approval.state,
                        ApprovalState::Approved | ApprovalState::Denied | ApprovalState::Consumed
                    )
                {
                    return Err(StoreError::Forbidden);
                }
                continue;
            }
            if event["type"] == "approval.requested" {
                let existing = approvals::get(&mut tx, parse_id(&event["payload"]["approvalId"])?)
                    .await?
                    .is_some();
                if terminal(run.state) && !existing {
                    return Err(StoreError::Conflict);
                }
                let (event, new) = self
                    .request_approval(&mut tx, &actor, id, event["payload"].clone())
                    .await?;
                if new {
                    run.state = RunState::WaitingForApproval;
                    changed = true;
                }
                result.push(event);
                continue;
            }
            if let Some(existing) =
                events::existing(&mut tx, id, event["sourceEventId"].as_str().unwrap()).await?
            {
                result.push(existing);
                continue;
            }
            if terminal(run.state) {
                return Err(StoreError::Conflict);
            }
            let mut event = event.clone();
            event["threadId"] = json!(thread.id);
            event["runId"] = json!(id);
            let persisted = events::append_in(&mut tx, event).await?;
            if persisted.kind == "run.usage" {
                add_usage(&mut run, &persisted.payload)?;
            }
            match persisted.kind.as_str() {
                "run.completed" | "run.cancelled" | "run.failed" => {
                    run.state = match persisted.kind.as_str() {
                        "run.completed" => RunState::Completed,
                        "run.cancelled" => RunState::Cancelled,
                        _ => RunState::Failed,
                    };
                    run.completed_at = Some(persisted.occurred_at);
                    run.error_code = if run.state == RunState::Failed {
                        Some(
                            persisted.payload["code"]
                                .as_str()
                                .unwrap_or("LOCAL_RUNTIME_FAILED")
                                .chars()
                                .take(255)
                                .collect(),
                        )
                    } else {
                        None
                    };
                }
                _ => {}
            }
            changed = true;
            result.push(persisted);
        }
        if changed {
            runs::update_in(
                &mut tx,
                id,
                &RunPatch {
                    state: Some(run.state),
                    input_tokens: Some(run.input_tokens),
                    output_tokens: Some(run.output_tokens),
                    cached_input_tokens: Some(run.cached_input_tokens),
                    cost_micros: Some(run.cost_micros),
                    completed_at: Some(run.completed_at),
                    error_code: Some(run.error_code),
                    ..Default::default()
                },
            )
            .await?;
            threads::update_in(
                &mut tx,
                &actor.workspace_id,
                thread.id,
                &ThreadPatch {
                    last_activity_at: Some(self.time()),
                    ..Default::default()
                },
            )
            .await?;
        }
        tx.commit().await?;
        Ok(result)
    }
    pub async fn cancel_local(&self, actor: &Actor, id: Uuid) -> Result<Event, StoreError> {
        let (mut tx, actor) = self.begin(actor, ApiScope::AgentsWrite, true).await?;
        let (_, run) = self.owned_run(&mut tx, &actor, id, true).await?;
        local(&run)?;
        if let Some(event) = events::existing(&mut tx, id, &format!("{id}:cancelled")).await? {
            tx.commit().await?;
            return Ok(event);
        }
        if terminal(run.state) {
            return Err(StoreError::Conflict);
        }
        let now = self.time();
        runs::update_in(
            &mut tx,
            id,
            &RunPatch {
                state: Some(RunState::Cancelled),
                completed_at: Some(Some(now)),
                ..Default::default()
            },
        )
        .await?;
        let event =
            forge_event(&mut tx, &run, "cancelled", "run.cancelled", now, json!({})).await?;
        tx.commit().await?;
        Ok(event)
    }
}
fn active_thread(thread: &Thread) -> Result<(), StoreError> {
    if thread.status == ThreadStatus::Archived {
        Err(error(
            "THREAD_ARCHIVED",
            "Reopen the thread before sending another message.",
        ))
    } else {
        Ok(())
    }
}
async fn forge_event(
    tx: &mut JournalTransaction,
    run: &Run,
    suffix: &str,
    kind: &str,
    now: DateTime<Utc>,
    payload: Value,
) -> Result<Event, StoreError> {
    events::append_in(tx,json!({"threadId":run.thread_id,"runId":run.id,"sourceEventId":format!("{}:{suffix}",run.id),"occurredAt":iso(now),"source":"forge","type":kind,"payload":payload})).await
}
fn add_usage(run: &mut Run, payload: &Value) -> Result<(), StoreError> {
    for (key, current) in [
        ("inputTokens", &mut run.input_tokens),
        ("outputTokens", &mut run.output_tokens),
        ("cachedInputTokens", &mut run.cached_input_tokens),
        ("costMicros", &mut run.cost_micros),
    ] {
        let increment = payload[key]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.)
            .unwrap_or(0.)
            .round();
        if increment > f64::from(i32::MAX) {
            return Err(StoreError::InvalidInput);
        }
        *current = current
            .checked_add(increment as i32)
            .ok_or(StoreError::InvalidInput)?;
    }
    Ok(())
}
