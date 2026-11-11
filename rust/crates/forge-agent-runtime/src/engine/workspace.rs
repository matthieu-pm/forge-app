use super::{
    Engine, Journal, State,
    state::{CallPhase, INVALID},
};
use crate::{
    Error, Result, framework,
    sandbox::{Cancellation, Workspace},
    workspace::Reference,
};
use serde_json::{Value, json};
use std::sync::Arc;
pub(super) fn is_framework(name: &str) -> bool {
    matches!(name, "bash" | "read_file" | "write_file" | "glob" | "grep")
}
pub(super) struct Session {
    pub sandbox: Arc<dyn Workspace>,
    tools: framework::Executor,
}
impl Engine {
    pub(super) fn prepare_authored(
        &self,
        name: &str,
        input: Value,
    ) -> Result<crate::tools::Prepared> {
        let prepared = self.executor.prepare(name, input)?;
        if prepared.requires_approval() {
            forge_core::agents::presentation::approval_input(prepared.input()).map_err(|_|Error("The approval input cannot be displayed safely. Reduce its size or remove authentication data."))?;
        }
        Ok(prepared)
    }
    pub(super) fn prepare_input(&self, name: &str, input: Value) -> Result<Value> {
        if name == "todo" {
            forge_core::agents::context::input(name, input)
                .map_err(|_| Error("Invalid task list input."))
        } else if name == "web_fetch" {
            forge_core::agents::web::input(name, input)
                .map_err(|_| Error("Invalid web-fetch input."))
        } else if is_framework(name) && self.workspace_factory.is_some() {
            forge_core::agents::framework::input(name, input)
                .map_err(|_| Error("Invalid framework tool input."))
        } else {
            Ok(self.prepare_authored(name, input)?.input().clone())
        }
    }
    pub(super) async fn ensure_workspace(
        &self,
        state: &mut State,
        journal: &dyn Journal,
        session: &mut Option<Arc<Session>>,
    ) -> Result<Arc<Session>> {
        if let Some(session) = session.as_ref().filter(|s| s.sandbox.is_usable()) {
            return Ok(session.clone());
        }
        // Retire an unusable handle before opening a new provider session.
        *session = None;
        let factory = self
            .workspace_factory
            .as_ref()
            .ok_or(Error("The isolated workspace is unavailable."))?;
        if state.workspace.is_none() {
            let mut next = state.clone();
            next.workspace = Some(Reference::new());
            next.files = framework::FileState::default();
            self.commit(state, journal, next, vec![]).await?;
        }
        let reference = state.workspace.as_ref().unwrap();
        let sandbox = factory.open(reference.key, !reference.provisioned).await?;
        if !sandbox.is_usable() || sandbox.identity() != reference.identity() {
            return Err(Error("The recovered workspace identity is invalid."));
        }
        if !reference.provisioned {
            let mut next = state.clone();
            next.workspace.as_mut().unwrap().provisioned = true;
            // No file write, shell command or model-directed workspace operation
            // is allowed before this acknowledgement is durable.
            self.commit(state, journal, next, vec![]).await?;
        }
        let opened = Arc::new(Session {
            tools: framework::Executor::new(sandbox.clone()),
            sandbox,
        });
        *session = Some(opened.clone());
        Ok(opened)
    }
    pub(super) async fn execute_framework(
        &self,
        state: &mut State,
        journal: &dyn Journal,
        cancellation: &Cancellation,
        session: &mut Option<Arc<Session>>,
    ) -> Result<()> {
        let call = state.calls[state.next_call].clone();
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
        let workspace = self.ensure_workspace(state, journal, session).await?;
        let mut next = state.clone();
        next.calls[next.next_call].phase = CallPhase::Calling;
        self.commit(state, journal, next, vec![]).await?;
        let mut files = state.files.clone();
        match workspace
            .tools
            .execute(&call.name, input, &mut files, cancellation)
            .await
        {
            Ok(output) => {
                self.settle_tool_with_files(
                    state,
                    journal,
                    json!({"type":"json","value":output}),
                    "completed",
                    Some(files),
                )
                .await
            }
            Err(error) => {
                let message = if workspace.sandbox.is_usable() {
                    error.to_string()
                } else {
                    "The sandbox operation was interrupted. Check its outcome before repeating it."
                        .into()
                };
                self.settle_tool(
                    state,
                    journal,
                    json!({"type":"error-text","value":message}),
                    "failed",
                )
                .await
            }
        }
    }
}
