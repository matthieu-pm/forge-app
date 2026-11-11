use crate::{Error, Result};
use async_trait::async_trait;
use std::sync::Arc;
use tokio::{
    sync::watch,
    time::{Duration, timeout},
};

pub struct Execution {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}
/// Implementations must isolate execution from host files, credentials and the
/// network, bound output while reading it, and terminate commands on future drop.
/// No user-supplied command is ever passed to a host shell by this library.
#[async_trait]
pub trait Sandbox: Send + Sync {
    async fn write(&self, path: &str, content: &str) -> Result<()>;
    async fn run(&self, command: &str) -> Result<Execution>;
    async fn remove(&self, path: &str) -> Result<()>;
}
/// Filesystem access is always inside the isolated sandbox. Implementations
/// bound reads before allocating, reject non-regular files, and retain the
/// Sandbox cancellation/drop guarantees. The identity changes on replacement.
#[async_trait]
pub trait Workspace: Sandbox {
    fn identity(&self) -> &str;
    async fn read_text(&self, path: &str) -> Result<Option<String>>;
    async fn write_text(&self, path: &str, content: &str) -> Result<()>;
}
pub const FILE_LIMIT: usize = 2 * 1024 * 1024;
#[derive(Clone)]
pub struct Cancellation(watch::Sender<bool>);
impl Default for Cancellation {
    fn default() -> Self {
        Self(watch::channel(false).0)
    }
}
impl Cancellation {
    pub fn cancel(&self) {
        self.0.send_replace(true);
    }
    pub fn is_cancelled(&self) -> bool {
        *self.0.borrow()
    }
    pub async fn cancelled(&self) {
        let mut receiver = self.0.subscribe();
        loop {
            if *receiver.borrow_and_update() {
                return;
            }
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }
}
pub(crate) struct Directory {
    sandbox: Arc<dyn Sandbox>,
    path: Option<String>,
}
impl Directory {
    pub fn new(sandbox: Arc<dyn Sandbox>, path: String) -> Self {
        Self {
            sandbox,
            path: Some(path),
        }
    }
    pub async fn finish<T>(mut self, result: Result<T>) -> Result<T> {
        let cleanup = timeout(
            Duration::from_secs(5),
            self.sandbox.remove(self.path.as_deref().unwrap()),
        )
        .await;
        // Remain armed during cleanup: dropping the caller also retries cleanup.
        self.path = None;
        match result {
            Err(e) => Err(e),
            Ok(v) => {
                cleanup.map_err(|_| Error("Sandbox cleanup timed out."))??;
                Ok(v)
            }
        }
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        if let Some(path) = self.path.take()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let sandbox = self.sandbox.clone();
            runtime.spawn(async move {
                let _ = timeout(Duration::from_secs(5), sandbox.remove(&path)).await;
            });
        }
    }
}
