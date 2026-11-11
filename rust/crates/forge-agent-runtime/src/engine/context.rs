use super::{
    Engine, Journal, Phase, State,
    state::{Compaction, INVALID},
    turn::event,
};
use crate::{
    Result,
    auth::Channel,
    context::{self, Plan},
    model::{
        stream::{Delta, Finish},
        transport::{Purpose, Sink, Turn},
    },
    sandbox::Cancellation,
};
use async_trait::async_trait;
use serde_json::json;
use tokio::time::Instant;
struct PrivateSummary;
#[async_trait]
impl Sink for PrivateSummary {
    async fn emit(&mut self, _: Delta) -> Result<()> {
        Ok(())
    }
}
impl Engine {
    pub(super) async fn compact(
        &self,
        channel: &Channel,
        state: &mut State,
        journal: &dyn Journal,
        cancellation: &Cancellation,
        deadline: Instant,
    ) -> Result<()> {
        let config = state.compaction.active.ok_or(INVALID)?;
        let mut plan = Plan::new(&state.messages[1..], config, false);
        loop {
            match plan {
                Plan::Complete(messages) => {
                    let mut next = state.clone();
                    next.messages.truncate(1);
                    next.messages.extend(messages);
                    if let Some(todos) = forge_core::agents::context::preservation(&state.todos) {
                        next.messages.push(todos);
                    }
                    next.files.clear();
                    next.compaction = Compaction::default();
                    // Generating records that compaction has already completed
                    // for this step; a restored worker must not summarize again.
                    next.phase = Phase::Generating;
                    next.validate(channel)?;
                    return self
                        .commit(
                            state,
                            journal,
                            next,
                            vec![event(
                                state,
                                "compaction.completed",
                                json!({"modelId":channel.model_id()}),
                            )],
                        )
                        .await;
                }
                Plan::Summarize(summary) => {
                    // Renew the journal revision before each summary request.
                    // A lost acknowledgement requires authoritative reload,
                    // while a discarded summary has no authored tool effects.
                    self.commit(state, journal, state.clone(), vec![]).await?;
                    let prompt = context::model_messages(&summary.prompt().messages());
                    let remaining = self.remaining_output(state)?;
                    if remaining == 0 {
                        return self
                            .fail(state, journal, "The agent token limit was reached.")
                            .await
                            .map(|_| ());
                    }
                    let completion = self
                        .model
                        .generate(
                            channel,
                            Turn {
                                prompt: &prompt,
                                tools: &[],
                                max_output_tokens: Some(remaining),
                                deadline,
                                purpose: Purpose::Compaction,
                            },
                            cancellation,
                            &mut PrivateSummary,
                        )
                        .await;
                    let text = completion
                        .ok()
                        .filter(|c| {
                            c.finish == Finish::Stop
                                && c.content.iter().all(|p| {
                                    matches!(p["type"].as_str(), Some("text" | "reasoning"))
                                })
                        })
                        .map(|c| {
                            c.content
                                .iter()
                                .filter(|p| p["type"] == "text")
                                .filter_map(|p| p["text"].as_str())
                                .collect::<String>()
                        })
                        .filter(|s| !forge_core::text::trim(s).is_empty());
                    let Some(text) = text else {
                        return self
                            .fail(
                                state,
                                journal,
                                "The model could not safely compact the conversation.",
                            )
                            .await
                            .map(|_| ());
                    };
                    plan = summary.accept(&text);
                }
            }
        }
    }
}
