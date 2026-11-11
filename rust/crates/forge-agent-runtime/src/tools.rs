use crate::{
    Error, Result,
    auth::Channel,
    callback::{Capabilities, Request},
    execution::{self, Features},
    sandbox::{Cancellation, Sandbox},
};
use forge_core::agents::{approval, tools as contracts};
use serde_json::Value;
use std::sync::Arc;

pub struct Prepared {
    name: String,
    input: Value,
    input_hash: String,
    approval: bool,
}
impl Prepared {
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn input(&self) -> &Value {
        &self.input
    }
    pub fn input_hash(&self) -> &str {
        &self.input_hash
    }
    pub fn requires_approval(&self) -> bool {
        self.approval
    }
}
pub enum Approval {
    Pending,
    Resolved {
        run_id: String,
        tool_name: String,
        input_hash: String,
        approved: bool,
    },
}
pub enum Outcome {
    ApprovalRequired(Prepared),
    Denied,
    Completed(Value),
}
pub struct Executor {
    pub capabilities: Arc<dyn Capabilities>,
    /// Obtained from an isolated backend by the owning session. Reads do not
    /// require a sandbox; the executor never creates a host-process fallback.
    pub sandbox: Option<Arc<dyn Sandbox>>,
    pub features: Features,
}
impl Executor {
    pub fn prepare(&self, name: &str, raw: Value) -> Result<Prepared> {
        let input = contracts::input(name, raw).map_err(|_| Error("Invalid Forge tool input."))?;
        if (name == "run_code" || name == "execute_program") && !self.features.code_mode {
            return Err(Error("Agent code mode is disabled."));
        }
        if name == "execute_program" && !self.features.programmatic_tools {
            return Err(Error("Programmatic Forge tools are disabled."));
        }
        let approval = contracts::needs_approval(name, &input);
        if approval && !self.features.write_tools {
            return Err(Error("Agent write tools are disabled."));
        }
        let input_hash = approval::input_hash(&input);
        Ok(Prepared {
            name: name.into(),
            input,
            input_hash,
            approval,
        })
    }
    pub async fn execute(
        &self,
        channel: &Channel,
        prepared: Prepared,
        approval: Approval,
        cancellation: &Cancellation,
    ) -> Result<Outcome> {
        if cancellation.is_cancelled() {
            return Err(Error("Tool execution cancelled."));
        }
        // Recheck feature gates at dispatch as well as preparation.
        let checked = self.prepare(&prepared.name, prepared.input.clone())?;
        if checked.input_hash != prepared.input_hash {
            return Err(Error("Tool input binding changed."));
        }
        if prepared.approval {
            match approval {
                Approval::Pending => return Ok(Outcome::ApprovalRequired(prepared)),
                Approval::Resolved {
                    run_id,
                    tool_name,
                    input_hash,
                    approved,
                } => {
                    if run_id != channel.run_id()
                        || tool_name != prepared.name
                        || input_hash != prepared.input_hash
                    {
                        return Err(Error("Tool approval binding mismatch."));
                    }
                    if !approved {
                        return Ok(Outcome::Denied);
                    }
                }
            }
        }
        let name = &prepared.name;
        let value = if name == "run_code" || name == "execute_program" {
            let sandbox = self
                .sandbox
                .clone()
                .ok_or(Error("The isolated sandbox is unavailable."))?;
            if name == "run_code" {
                execution::run_code(sandbox, prepared.input, self.features, cancellation).await?
            } else {
                execution::execute_program(
                    sandbox,
                    self.capabilities.as_ref(),
                    channel,
                    prepared.input,
                    self.features,
                    cancellation,
                )
                .await?
            }
        } else {
            let id = match name.as_str() {
                "list_teams" => "teams.list",
                "get_team" => "teams.get",
                "describe_workspace" => "workspace.describe",
                "update_team" => "teams.update",
                "create_artifact" => "artifacts.create",
                _ => return Err(Error("Unknown Forge tool.")),
            };
            let request = Request {
                id: id.into(),
                version: "1".into(),
                input: prepared.input,
                idempotency_key: (name == "update_team").then(|| {
                    format!(
                        "eve:{}:teams.update:{}",
                        channel.run_id(),
                        prepared.input_hash
                    )
                }),
            };
            let value = tokio::select! {biased;()=cancellation.cancelled()=>return Err(Error("Tool execution cancelled.")),value=self.capabilities.call(channel,request)=>value?};
            if cancellation.is_cancelled() {
                return Err(Error("Tool execution cancelled."));
            }
            contracts::output(name, value)
                .map_err(|_| Error("Forge returned an invalid tool response."))?
        };
        Ok(Outcome::Completed(value))
    }
}
