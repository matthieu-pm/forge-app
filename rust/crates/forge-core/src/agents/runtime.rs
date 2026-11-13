use async_trait::async_trait;
use futures_core::Stream;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{pin::Pin, sync::Arc};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct Error(pub &'static str);
pub type Events = Pin<Box<dyn Stream<Item = Result<Value, Error>> + Send>>;

/// Private managed-delivery protocol. These receipts never contain credentials
/// and do not confer canonical application approval authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationFence {
    pub conversation_id: Uuid,
    pub head_run_id: Uuid,
    pub generation: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeliveryPhase {
    Ready,
    Generating,
    Compacting,
    Tools,
    Waiting,
    Complete,
    Cancelled,
    Failed,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliverySnapshot {
    pub run_id: Uuid,
    pub input_generation: u64,
    pub state_revision: u64,
    pub next_index: u64,
    pub phase: DeliveryPhase,
    pub cancelled: bool,
    pub delivery_only: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DrainBoundary {
    pub conversation: ConversationFence,
    /// The application stream that was consumed. A deferred delivery B can
    /// finish while execution remains owned by A.
    pub delivery: DeliverySnapshot,
    pub execution: DeliverySnapshot,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueuedInput {
    pub intent_id: Uuid,
    pub conversation_id: Uuid,
    pub request_id: Uuid,
    pub approved: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntentState {
    Queued,
    Prepared,
    Activated,
    Cancelled,
    Expired,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntentReceipt {
    pub intent_id: Uuid,
    pub sequence: u64,
    pub original_run_id: Uuid,
    pub request_id: Uuid,
    pub approved: bool,
    pub state: IntentState,
    pub handoff_id: Option<Uuid>,
    pub activation_run_id: Option<Uuid>,
    pub stream_start_index: Option<u64>,
    pub replayed: bool,
    pub conversation: ConversationFence,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandoffAuthority {
    pub provider: String,
    pub model_id: String,
    pub reasoning_effort: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandoffPlan {
    pub id: Uuid,
    pub conversation: ConversationFence,
    pub anchor_intent_id: Uuid,
    pub intent_ids: Vec<Uuid>,
    pub prefix_end_sequence: u64,
    pub activation_run_id: Uuid,
    pub authority: HandoffAuthority,
    pub boundary: DrainBoundary,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case", deny_unknown_fields)]
#[allow(clippy::large_enum_variant)]
pub enum Preparation {
    Empty,
    AwaitingDrain,
    Ready { plan: HandoffPlan },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryReceipt {
    pub run_id: Uuid,
    pub input_generation: u64,
    pub stream_start_index: u64,
    pub current_delivery: bool,
    pub replayed: bool,
    pub handoff_id: Option<Uuid>,
}
#[allow(clippy::large_enum_variant)]
pub enum OpenDelivery {
    Start {
        message: String,
        attachments: Vec<Value>,
    },
    Recover {
        input_generation: u64,
    },
    Activate {
        plan: HandoffPlan,
    },
}
#[allow(clippy::large_enum_variant)]
pub enum DeliveryFrame {
    Event(Value),
    /// All preceding public events were yielded before this certified boundary.
    /// The application must commit this cursor and its terminal/pending state
    /// together before acknowledging the boundary to the private runtime.
    Parked {
        boundary: DrainBoundary,
        final_cursor: String,
    },
}
pub type DeliveryFrames = Pin<Box<dyn Stream<Item = Result<DeliveryFrame, Error>> + Send>>;
pub struct ManagedSession {
    pub admission: DeliveryReceipt,
    pub frames: DeliveryFrames,
}
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
    fn supports_delivery_queue(&self) -> bool {
        false
    }
    async fn enqueue_input(
        &self,
        _context: &Context,
        _input: &QueuedInput,
    ) -> Result<IntentReceipt, Error> {
        Err(Error("This runtime does not support queued delivery."))
    }
    async fn acknowledge_drained(
        &self,
        _context: &Context,
        _boundary: &DrainBoundary,
    ) -> Result<(), Error> {
        Err(Error("This runtime does not support queued delivery."))
    }
    async fn prepare_handoff(
        &self,
        _context: &Context,
        _fence: &ConversationFence,
    ) -> Result<Preparation, Error> {
        Err(Error("This runtime does not support queued delivery."))
    }
    async fn open_delivery(
        &self,
        _context: Context,
        _delivery: OpenDelivery,
    ) -> Result<ManagedSession, Error> {
        Err(Error("This runtime does not support queued delivery."))
    }
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
