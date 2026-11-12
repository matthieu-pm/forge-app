use async_trait::async_trait;
use futures_core::Stream;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{pin::Pin, sync::Arc};

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct Error(pub &'static str);
pub type Events = Pin<Box<dyn Stream<Item = Result<Value, Error>> + Send>>;
/// An admitted private conversation checkpoint. Input/completion flags certify
/// a fully drained delivery; otherwise only an application terminal state may
/// permit a new composer turn. Delivery and execution ownership can differ.
pub struct Continuation {
    pub head_run_id: String,
    pub owner_run_id: String,
    pub pending_inputs: bool,
    pub delivery_complete: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub workspace_id: String,
    pub user_id: String,
    pub workspace_role: String,
}
#[async_trait]
pub trait Checkpoint: Send + Sync {
    async fn save(&self, cursor: String) -> Result<(), Error>;
    /// Roll back a first admission only after the runtime definitively rejected
    /// it. Unknown delivery outcomes must retain their recovery checkpoint.
    async fn clear(&self) -> Result<(), Error> {
        Err(Error("This runtime checkpoint cannot be cleared."))
    }
}
#[derive(Clone)]
pub struct Context {
    pub thread_id: String,
    pub run_id: String,
    pub identity: Identity,
    pub model: Value,
    pub reasoning_effort: String,
    /// Absolute deadline derived from the persisted start and configured limit.
    pub deadline_ms: i64,
    pub runtime_session_id: Option<String>,
    pub correlation_id: Option<String>,
    pub checkpoint: Arc<dyn Checkpoint>,
}
#[async_trait]
pub trait Runtime: Send + Sync {
    fn kind(&self) -> &'static str;
    /// The private cursor's run owner, when this adapter has a durable native
    /// conversation protocol. Never infer ownership from browser input.
    fn cursor_run_id(&self, _cursor: &str) -> Option<String> {
        None
    }
    /// A native head with a fully delivered ordinary-question batch, or a
    /// confirmed admission when the application has ended that run. Required
    /// approval and session-limit continuation remain a separate path.
    fn question_continuation_run(&self, _cursor: &str, _terminal: bool) -> Option<String> {
        None
    }
    fn input_continuation(&self, _cursor: &str) -> Option<Continuation> {
        None
    }
    /// Whether repeating the same approval delivery is a durable no-op.
    fn idempotent_resumption(&self) -> bool {
        false
    }
    /// Native run journals must be ended when the application gives up recovery.
    fn cancel_after_transport_failure(&self) -> bool {
        false
    }
    fn start(&self, context: Context, message: String, attachments: Vec<Value>) -> Events;
    fn resume(&self, context: Context, input_responses: Vec<Value>) -> Events;
    fn reconnect(&self, context: Context) -> Events;
    async fn cancel(
        &self,
        run: &str,
        cursor: Option<&str>,
        context: Option<&Context>,
    ) -> Result<(), Error>;
}
