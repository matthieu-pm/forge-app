use super::{
    Engine, Journal, State,
    state::{CallPhase, INVALID},
};
use crate::{Result, sandbox::Cancellation};
use serde_json::json;
impl Engine {
    pub(super) async fn execute_web(
        &self,
        state: &mut State,
        journal: &dyn Journal,
        cancellation: &Cancellation,
    ) -> Result<()> {
        let call = &state.calls[state.next_call];
        let input = match self.prepare_input(&call.name, call.input.clone()) {
            Ok(input) => input,
            Err(error) => {
                return self
                    .settle_tool(
                        state,
                        journal,
                        json!({"type":"error-text","value":error.to_string()}),
                        "failed",
                    )
                    .await;
            }
        };
        if call.input_hash.as_deref() != Some(&forge_core::agents::approval::input_hash(&input))
            || call.request_id.is_some()
            || call.decision.is_some()
        {
            return Err(INVALID);
        }
        let mut next = state.clone();
        next.calls[next.next_call].phase = CallPhase::Calling;
        self.commit(state, journal, next, vec![]).await?;
        match self.web.execute(input, cancellation).await {
            Ok(output) => {
                self.settle_tool(
                    state,
                    journal,
                    json!({"type":"json","value":output}),
                    "completed",
                )
                .await
            }
            Err(error) => {
                self.settle_tool(
                    state,
                    journal,
                    json!({"type":"error-text","value":error.to_string()}),
                    "failed",
                )
                .await
            }
        }
    }
}
