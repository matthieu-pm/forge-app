//! Checkpointed authored-tool turns. Persistence is supplied by an owning
//! service; this module never treats in-memory progress as a durable receipt.
mod state;
mod turn;
use crate::Result;
use async_trait::async_trait;
use serde_json::Value;
pub use state::{Decision, Phase, State};
pub use turn::Engine;

#[async_trait]
pub trait Journal: Send + Sync {
    /// Atomically install `next` and append its events, only if the persisted
    /// revision equals `expected`. Implementations must also fence their worker
    /// ownership. An error, including an ambiguous commit, forbids more effects
    /// until the caller reloads the authoritative state.
    async fn commit(&self, expected: u64, next: &State, events: &[Value]) -> Result<()>;
    /// Append streamed output under the same revision and worker-ownership fence.
    /// Awaiting this method provides backpressure to the model transport.
    async fn append(&self, revision: u64, event: Value) -> Result<()>;
}
