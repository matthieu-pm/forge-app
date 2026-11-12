use super::super::local::{add_usage, forge_event};
use super::*;
use approval_service::Decision;
use sha2::{Digest, Sha256};

impl Service {
    // A resolution transfers ownership to the resumed stream. Old transports
    // cannot subsequently overwrite its cursor or move it back into waiting.
    pub(super) async fn phase(
        &self,
        actor: &Actor,
        id: Uuid,
        epoch: i32,
        write: bool,
    ) -> Result<Option<(JournalTransaction, Actor, Thread, Run)>, StoreError> {
        let (mut tx, actor) = self.begin(actor, ApiScope::AgentsWrite, write).await?;
        let (thread, run) = self.owned_run(&mut tx, &actor, id, write).await?;
        let current:i32=sqlx::query_scalar("SELECT COALESCE(MAX(sequence),0) FROM agent_events WHERE run_id=$1 AND type='approval.resolved'").bind(id).fetch_one(&mut *tx).await?;
        if terminal(run.state) || current != epoch {
            tx.commit().await?;
            return Ok(None);
        }
        if run.state == RunState::WaitingForApproval {
            let runtime = self.runtime(thread.runtime_kind)?;
            if let Some(owner) = thread
                .runtime_session_id
                .as_deref()
                .and_then(|cursor| runtime.cursor_run_id(cursor))
            {
                let successor: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agent_runs WHERE thread_id=$1 AND id<>$2 AND state IN ('created','connecting','running','reconnecting'))")
                    .bind(thread.id).bind(id).fetch_one(&mut *tx).await?;
                if owner != id.to_string() || successor {
                    tx.commit().await?;
                    return Ok(None);
                }
            }
        }
        Ok(Some((tx, actor, thread, run)))
    }
    pub(super) async fn start_stream(
        &self,
        actor: &Actor,
        id: Uuid,
        epoch: i32,
    ) -> Result<Option<Event>, StoreError> {
        let Some((mut tx, _, _, run)) = self.phase(actor, id, epoch, true).await? else {
            return Ok(None);
        };
        if run.state != RunState::Created {
            return Err(StoreError::Conflict);
        }
        runs::update_in(
            &mut tx,
            id,
            &RunPatch {
                state: Some(RunState::Running),
                started_at: Some(Some(self.time())),
                ..Default::default()
            },
        )
        .await?;
        let event = forge_event(
            &mut tx,
            &run,
            "started",
            "run.started",
            self.time(),
            json!({}),
        )
        .await?;
        tx.commit().await?;
        Ok(Some(event))
    }
    pub(super) async fn persist_runtime(
        &self,
        actor: &Actor,
        id: Uuid,
        epoch: i32,
        mut event: Value,
    ) -> Result<Option<Event>, StoreError> {
        let Some((mut tx, actor, thread, mut run)) = self.phase(actor, id, epoch, true).await?
        else {
            return Ok(None);
        };
        contracts::safe_payload(&event["payload"]).map_err(|_| StoreError::InvalidInput)?;
        event["threadId"] = json!(thread.id);
        event["runId"] = json!(id);
        if event.get("occurredAt").is_none() {
            event["occurredAt"] = json!(iso(self.time()));
        }
        let event = contracts::event(event, true, false).map_err(|_| StoreError::InvalidInput)?;
        if event["source"] != json!(thread.runtime_kind) {
            return Err(StoreError::Forbidden);
        }
        let source = event["sourceEventId"].as_str().unwrap();
        if event["type"] == "approval.requested" {
            let mut payload = contracts::runtime_approval(event["payload"].clone(), false)
                .map_err(|_| StoreError::InvalidInput)?;
            if payload.get("approvalId").is_none() {
                let hash = Sha256::digest(format!("forge-runtime-approval:{id}:{source}"));
                let mut bytes: [u8; 16] = hash[..16].try_into().unwrap();
                bytes[6] = (bytes[6] & 15) | 80;
                bytes[8] = (bytes[8] & 63) | 128;
                payload["approvalId"] = json!(Uuid::from_bytes(bytes));
            }
            if payload.get("expiresAt").is_none() {
                payload["expiresAt"] = json!(iso(self.time() + chrono::Duration::minutes(5)));
            }
            let (event, _) = self.request_approval(&mut tx, &actor, id, payload).await?;
            tx.commit().await?;
            return Ok(Some(event));
        }
        // Only the canonical approval service can resolve human decisions.
        if event["type"] == "approval.resolved" {
            return Err(StoreError::Forbidden);
        }
        if let Some(existing) = events::existing(&mut tx, id, source).await? {
            if existing.kind == "run.completed" && event["type"] == "run.completed" {
                // A partial required-input reply can complete the delivery while
                // retaining pending session input. A later canonical reply
                // reopens the same run; its stable completion receipt must still
                // settle that new delivery without recounting any usage.
                runs::update_in(
                    &mut tx,
                    id,
                    &RunPatch {
                        state: Some(RunState::Completed),
                        completed_at: Some(Some(self.time())),
                        error_code: Some(None),
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
            return Ok(Some(existing));
        }
        if event["type"] == "run.usage" {
            add_usage(&mut run, &event["payload"])?;
            for (used, key, code, message) in [
                (
                    run.input_tokens,
                    "maxInputTokens",
                    "INPUT_TOKEN_LIMIT",
                    "The run reached its input-token limit.",
                ),
                (
                    run.output_tokens,
                    "maxOutputTokens",
                    "OUTPUT_TOKEN_LIMIT",
                    "The run reached its output-token limit.",
                ),
            ] {
                if self.controls[key]
                    .as_i64()
                    .is_some_and(|limit| i64::from(used) > limit)
                {
                    return Err(error(code, message));
                }
            }
        }
        let persisted = events::append_in(&mut tx, event).await?;
        match persisted.kind.as_str() {
            "run.waiting" => run.state = RunState::WaitingForApproval,
            "run.cancelled" | "run.failed" | "run.completed" => {
                run.state = match persisted.kind.as_str() {
                    "run.cancelled" => RunState::Cancelled,
                    "run.failed" => RunState::Failed,
                    _ => RunState::Completed,
                };
                run.completed_at = Some(self.time());
                run.error_code =
                    (run.state == RunState::Failed).then(|| "RUNTIME_EXECUTION_FAILED".into());
            }
            _ => {}
        }
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
        tx.commit().await?;
        Ok(Some(persisted))
    }
    pub(super) async fn finish_stream(
        &self,
        actor: &Actor,
        id: Uuid,
        epoch: i32,
        failure: Option<(&'static str, &'static str)>,
        resume: bool,
    ) -> Result<Option<Event>, StoreError> {
        let Some((mut tx, actor, thread, run)) = self.phase(actor, id, epoch, true).await? else {
            return Ok(None);
        };
        if failure.is_none() && run.state == RunState::WaitingForApproval {
            tx.commit().await?;
            return Ok(None);
        }
        let (state, suffix, kind, payload, code) = match failure {
            Some((code, message)) => (
                RunState::Failed,
                if resume { "resume-failed" } else { "failed" },
                "run.failed",
                json!({"errorCode":code,"message":message}),
                Some(code.into()),
            ),
            None => (
                RunState::Completed,
                "completed",
                "run.completed",
                json!({}),
                None,
            ),
        };
        runs::update_in(
            &mut tx,
            id,
            &RunPatch {
                state: Some(state),
                completed_at: Some(Some(self.time())),
                error_code: Some(code),
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
        let event = forge_event(&mut tx, &run, suffix, kind, self.time(), payload).await?;
        tx.commit().await?;
        Ok(Some(event))
    }
    pub async fn cancel_run(&self, actor: &Actor, id: Uuid) -> Result<Event, StoreError> {
        let (mut tx, actor) = self.begin(actor, ApiScope::AgentsWrite, true).await?;
        let (thread, run) = self.owned_run(&mut tx, &actor, id, true).await?;
        if let Some(event) = events::existing(&mut tx, id, &format!("{id}:cancelled")).await? {
            tx.commit().await?;
            return Ok(event);
        }
        if terminal(run.state) {
            return Err(StoreError::Conflict);
        }
        runs::update_in(
            &mut tx,
            id,
            &RunPatch {
                state: Some(RunState::Cancelled),
                completed_at: Some(Some(self.time())),
                ..Default::default()
            },
        )
        .await?;
        let event = forge_event(
            &mut tx,
            &run,
            "cancelled",
            "run.cancelled",
            self.time(),
            json!({}),
        )
        .await?;
        tx.commit().await?;
        // Revoke the run before waiting on a remote cancellation response.
        if let Ok(runtime) = self.runtime(thread.runtime_kind) {
            let context = stream::context(self, &actor, &thread, &run, 0, None);
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                runtime.cancel(
                    &id.to_string(),
                    thread.runtime_session_id.as_deref(),
                    Some(&context),
                ),
            )
            .await;
        }
        Ok(event)
    }
    pub async fn resolve_approval(
        &self,
        actor: &Actor,
        id: Uuid,
        decision: Decision,
        correlation: Option<String>,
    ) -> Result<RunSession, StoreError> {
        let (mut tx, actor) = self.begin(actor, ApiScope::AgentsWrite, true).await?;
        let approval = approvals::get(&mut tx, id)
            .await?
            .filter(|a| {
                a.workspace_id == actor.workspace_id && a.requested_for_user_id == actor.user_id
            })
            .ok_or(StoreError::Forbidden)?;
        let (thread, run) = self
            .owned_run(&mut tx, &actor, approval.run_id, true)
            .await?;
        // Validate the resumption binding before spending the human decision.
        let mut completed_delivery = false;
        let hosted = if thread.runtime_kind == Runtime::Eve {
            let request = approval.redacted_input_summary["details"]["runtimeRequestId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(unavailable)?;
            if thread.runtime_session_id.is_none()
                || run.resolved_connection_id.is_none()
                || run.resolved_model_id.is_none()
            {
                return Err(unavailable());
            }
            let runtime = self.runtime(thread.runtime_kind)?;
            let proof = self
                .certified_input_continuation(&mut tx, &actor, &thread, runtime.as_ref(), false)
                .await?;
            let cursor = thread.runtime_session_id.as_deref().unwrap();
            if let Some(owner) = runtime.cursor_run_id(cursor) {
                if owner != run.id.to_string() && proof.is_none() {
                    return Err(StoreError::Conflict);
                }
                if approval.state == ApprovalState::Pending {
                    // Recording another decision would advance the stream's
                    // approval epoch before the native runtime can deliver it.
                    // Also fence the interval after a successor is created but
                    // before it saves a cursor naming that new run. Durable
                    // queued delivery needs an independent ownership claim.
                    let busy: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agent_runs WHERE thread_id=$1 AND state IN ('created','connecting','running','reconnecting'))")
                        .bind(thread.id).fetch_one(&mut *tx).await?;
                    if busy {
                        return Err(StoreError::Conflict);
                    }
                }
            }
            completed_delivery = run.state == RunState::Completed && proof.is_some();
            Some((
                runtime,
                vec![
                    json!({"requestId":request,"optionId":match decision{Decision::Approved=>"approve",Decision::Denied=>"deny"}}),
                ],
            ))
        } else {
            None
        };
        let reviewer = if let Some(binding) = &self.loop_binding {
            Some(
                crate::loops::decision_reviewer(
                    &mut tx,
                    &actor,
                    binding.run_id,
                    id,
                    match decision {
                        Decision::Approved => "approve",
                        Decision::Denied => "deny",
                    },
                )
                .await?,
            )
        } else {
            None
        };
        let result = approval_service::Service::new(self.database.clone())
            .with_clock(self.now.clone())
            .resolve_in_with_native_continuation(&mut tx, &actor, id, decision, completed_delivery)
            .await;
        let resolution = match result {
            Ok(r) => r,
            Err(e) => {
                if matches!(&e,StoreError::Approval(e)if e.code==forge_core::agents::approval::Code::ApprovalExpired)
                {
                    tx.commit().await?;
                }
                return Err(e);
            }
        };
        if let Some(reviewer) = reviewer {
            sqlx::query(
                "UPDATE agent_approvals SET resolved_by_user_id=$2 WHERE id=$1 AND run_id=$3",
            )
            .bind(id)
            .bind(reviewer)
            .bind(run.id)
            .execute(&mut *tx)
            .await?;
        }
        let run = runs::get_in(&mut tx, &actor.workspace_id, run.id)
            .await?
            .ok_or_else(run_missing)?;
        tx.commit().await?;
        let events = if let Some((runtime, responses)) = hosted {
            stream::open(Prepared {
                service: self.clone(),
                actor,
                thread,
                run: run.clone(),
                runtime,
                epoch: resolution.event.sequence,
                initial: vec![resolution.event],
                mode: Mode::Resume(responses),
                correlation,
            })
        } else {
            Box::pin(futures_util::stream::iter([Ok(resolution.event)])) as EventStream
        };
        Ok(RunSession { run, events })
    }
}
