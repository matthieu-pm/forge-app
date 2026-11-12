use super::super::local::forge_event;
use super::*;
use async_trait::async_trait;
use futures_util::StreamExt;
use std::{collections::VecDeque, time::Duration};
use tokio::time::{Instant, timeout, timeout_at};

struct Checkpoint {
    service: Service,
    actor: Actor,
    run: Uuid,
    epoch: i32,
}
#[async_trait]
impl runtime::Checkpoint for Checkpoint {
    async fn save(&self, cursor: String) -> Result<(), runtime::Error> {
        async {
            let Some((mut tx, actor, thread, _)) = self
                .service
                .phase(&self.actor, self.run, self.epoch, true)
                .await?
            else {
                return Err(StoreError::Conflict);
            };
            threads::update_in(
                &mut tx,
                &actor.workspace_id,
                thread.id,
                &ThreadPatch {
                    runtime_session_id: Some(Some(cursor)),
                    last_activity_at: Some(self.service.time()),
                    ..Default::default()
                },
            )
            .await?;
            tx.commit().await
        }
        .await
        .map_err(|_| runtime::Error("The runtime checkpoint could not be saved."))
    }
}
pub(super) fn context(
    service: &Service,
    actor: &Actor,
    thread: &Thread,
    run: &Run,
    epoch: i32,
    correlation: Option<String>,
) -> runtime::Context {
    runtime::Context {
        thread_id: thread.id.to_string(),
        run_id: run.id.to_string(),
        identity: runtime::Identity {
            workspace_id: actor.workspace_id.clone(),
            user_id: actor.user_id.clone(),
            workspace_role: actor.workspace_role.clone(),
        },
        model: json!({"selectionId":run.requested_selection["selectionId"].as_str().unwrap_or("auto"),"connectionId":run.resolved_connection_id,"executionKind":run.execution_kind,"provider":run.requested_selection["provider"].as_str().unwrap_or("openai"),"modelId":run.resolved_model_id}),
        reasoning_effort: json!(run.reasoning_effort.unwrap_or(Effort::Medium))
            .as_str()
            .unwrap()
            .into(),
        deadline_ms: service.run_deadline(run),
        runtime_session_id: thread.runtime_session_id.clone(),
        correlation_id: correlation,
        checkpoint: Arc::new(Checkpoint {
            service: service.clone(),
            actor: actor.clone(),
            run: run.id,
            epoch,
        }),
    }
}
struct State {
    p: Prepared,
    initial: VecDeque<Event>,
    started: bool,
    events: Option<runtime::Events>,
    deadline: Option<Instant>,
    reconnected: bool,
    done: bool,
}
pub(super) fn open(mut p: Prepared) -> EventStream {
    let initial = std::mem::take(&mut p.initial).into();
    Box::pin(futures_util::stream::try_unfold(
        State {
            p,
            initial,
            started: false,
            events: None,
            deadline: None,
            reconnected: false,
            done: false,
        },
        |mut state| async move {
            if state.done {
                return Ok(None);
            }
            let Some((tx, actor, thread, run)) = state
                .p
                .service
                .phase(&state.p.actor, state.p.run.id, state.p.epoch, false)
                .await?
            else {
                return Ok(None);
            };
            tx.commit().await?;
            state.p.actor = actor;
            state.p.thread = thread;
            state.p.run = run;
            if let Some(event) = state.initial.pop_front() {
                return Ok(Some((event, state)));
            }
            if !state.started {
                state.started = true;
                if matches!(state.p.mode, Mode::Start { .. }) {
                    let Some(event) = state
                        .p
                        .service
                        .start_stream(&state.p.actor, state.p.run.id, state.p.epoch)
                        .await?
                    else {
                        return Ok(None);
                    };
                    return Ok(Some((event, state)));
                }
            }
            if state.events.is_none() {
                let ctx = state.context();
                state.events = Some(match &state.p.mode {
                    Mode::Start {
                        message,
                        attachments,
                    } => state
                        .p
                        .runtime
                        .start(ctx, message.clone(), attachments.clone()),
                    Mode::Resume(responses) => state.p.runtime.resume(ctx, responses.clone()),
                });
                state.deadline = Some(
                    Instant::now()
                        + Duration::from_millis(state.p.service.stream_window(&state.p.run)),
                );
            }
            if Instant::now() >= state.deadline.unwrap() {
                return state
                    .fail(
                        "RUN_WALL_CLOCK_LIMIT",
                        "The run reached its wall-clock time limit.",
                        true,
                    )
                    .await;
            }
            let result = timeout_at(
                state.deadline.unwrap(),
                state.events.as_mut().unwrap().next(),
            )
            .await;
            match result {
                Err(_) => {
                    state
                        .fail(
                            "RUN_WALL_CLOCK_LIMIT",
                            "The run reached its wall-clock time limit.",
                            true,
                        )
                        .await
                }
                Ok(None) => {
                    let event = state
                        .p
                        .service
                        .finish_stream(
                            &state.p.actor,
                            state.p.run.id,
                            state.p.epoch,
                            None,
                            matches!(state.p.mode, Mode::Resume(_)),
                        )
                        .await?;
                    state.done = true;
                    Ok(event.map(|event| (event, state)))
                }
                Ok(Some(Ok(event))) => {
                    match state
                        .p
                        .service
                        .persist_runtime(&state.p.actor, state.p.run.id, state.p.epoch, event)
                        .await
                    {
                        Ok(Some(event)) => {
                            state.done = matches!(
                                event.kind.as_str(),
                                "run.failed" | "run.cancelled" | "run.completed"
                            );
                            Ok(Some((event, state)))
                        }
                        Ok(None) => Ok(None),
                        Err(StoreError::AgentCoordinator { code, message })
                            if matches!(code, "INPUT_TOKEN_LIMIT" | "OUTPUT_TOKEN_LIMIT") =>
                        {
                            state.fail(code, message, true).await
                        }
                        Err(StoreError::InvalidInput) => {
                            state
                                .fail(
                                    "RUNTIME_EXECUTION_FAILED",
                                    "Forge could not complete this run.",
                                    true,
                                )
                                .await
                        }
                        Err(e) => Err(e),
                    }
                }
                Ok(Some(Err(_))) => {
                    if !state.reconnected {
                        state.reconnected = true;
                        let Some((mut tx, actor, thread, run)) = state
                            .p
                            .service
                            .phase(&state.p.actor, state.p.run.id, state.p.epoch, true)
                            .await?
                        else {
                            return Ok(None);
                        };
                        if thread.runtime_session_id.is_some() {
                            runs::update_in(
                                &mut tx,
                                run.id,
                                &RunPatch {
                                    state: Some(RunState::Reconnecting),
                                    ..Default::default()
                                },
                            )
                            .await?;
                            let event=forge_event(&mut tx,&run,"runtime-reconnecting","progress.note",state.p.service.time(),json!({"message":"The agent runtime connection was interrupted. Forge resumed from its durable checkpoint.","state":"reconnecting"})).await?;
                            tx.commit().await?;
                            state.p.actor = actor;
                            state.p.thread = thread;
                            state.p.run = run;
                            state.events = Some(match &state.p.mode {
                                Mode::Resume(responses)
                                    if state.p.runtime.idempotent_resumption() =>
                                {
                                    state.p.runtime.resume(state.context(), responses.clone())
                                }
                                _ => state.p.runtime.reconnect(state.context()),
                            });
                            return Ok(Some((event, state)));
                        }
                        tx.commit().await?;
                    }
                    let cancel = state.p.runtime.cancel_after_transport_failure();
                    state
                        .fail(
                            "RUNTIME_EXECUTION_FAILED",
                            "Forge could not complete this run.",
                            cancel,
                        )
                        .await
                }
            }
        },
    ))
}
impl State {
    fn context(&self) -> runtime::Context {
        context(
            &self.p.service,
            &self.p.actor,
            &self.p.thread,
            &self.p.run,
            self.p.epoch,
            self.p.correlation.clone(),
        )
    }
    async fn fail(
        mut self,
        code: &'static str,
        message: &'static str,
        cancel: bool,
    ) -> Result<Option<(Event, Self)>, StoreError> {
        // Failure closes current authority before any slow provider cleanup.
        let event = self
            .p
            .service
            .finish_stream(
                &self.p.actor,
                self.p.run.id,
                self.p.epoch,
                Some((code, message)),
                matches!(self.p.mode, Mode::Resume(_)),
            )
            .await?;
        self.done = true;
        if cancel && event.is_some() {
            let thread = threads::get(
                &self.p.service.database,
                &self.p.actor.workspace_id,
                self.p.thread.id,
            )
            .await?;
            if let Some(thread) = thread {
                self.p.thread = thread;
            }
            let _ = timeout(
                Duration::from_secs(30),
                self.p.runtime.cancel(
                    &self.p.run.id.to_string(),
                    self.p.thread.runtime_session_id.as_deref(),
                    Some(&self.context()),
                ),
            )
            .await;
        }
        Ok(event.map(|event| (event, self)))
    }
}
