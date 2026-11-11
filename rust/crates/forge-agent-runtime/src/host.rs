//! Process-owned task supervision. Durable state remains in Store; this bounded
//! registry only coordinates local wakeups and keeps credentials in memory.
use crate::{
    Error, Result,
    auth::Channel,
    journal::Store,
    sandbox::Cancellation,
    worker::{Factory, Options, Worker},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::{
    sync::{Notify, Semaphore},
    time::{Duration, timeout},
};
use uuid::Uuid;

struct Entry {
    owner: Uuid,
    channel: Channel,
    pending: bool,
    stop: Cancellation,
}
struct Inner {
    store: Store,
    worker: Worker,
    active: Mutex<HashMap<String, Entry>>,
    slots: Arc<Semaphore>,
    readers: Arc<Semaphore>,
    stopping: Cancellation,
    changed: Notify,
}
#[derive(Clone)]
pub struct Host(Arc<Inner>);
impl Host {
    pub fn new(
        store: Store,
        factory: Arc<dyn Factory>,
        options: Options,
        workers: usize,
        readers: usize,
    ) -> Result<Self> {
        if !(1..=256).contains(&workers) || !(1..=512).contains(&readers) {
            return Err(Error("Invalid runtime concurrency configuration."));
        }
        Ok(Self(Arc::new(Inner {
            worker: Worker::new(store.clone(), factory, options)?,
            store,
            active: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(workers)),
            readers: Arc::new(Semaphore::new(readers)),
            stopping: Cancellation::default(),
            changed: Notify::new(),
        })))
    }
    pub fn store(&self) -> &Store {
        &self.0.store
    }
    pub fn is_stopping(&self) -> bool {
        self.0.stopping.is_cancelled()
    }
    pub fn is_active(&self, run: &str) -> bool {
        self.0
            .active
            .lock()
            .is_ok_and(|active| active.contains_key(run))
    }
    pub(crate) fn reader(&self) -> Result<tokio::sync::OwnedSemaphorePermit> {
        self.0
            .readers
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error("The runtime stream capacity is exhausted."))
    }
    /// Call only after scoped admission/load/approval persistence has succeeded.
    /// The registry bounds both concurrent workers and stored channel credentials.
    pub fn kick(&self, channel: Channel) -> Result<()> {
        let mut active = self
            .0
            .active
            .lock()
            .map_err(|_| Error("The runtime host is unavailable."))?;
        if self.0.stopping.is_cancelled() {
            return Err(Error("The runtime host is shutting down."));
        }
        if let Some(entry) = active.get_mut(channel.run_id()) {
            if entry.channel.principal_id() != channel.principal_id()
                || entry.channel.workspace_id() != channel.workspace_id()
                || entry.channel.provider() != channel.provider()
                || entry.channel.model_id() != channel.model_id()
            {
                return Err(Error("The runtime wakeup is outside this run's scope."));
            }
            // A decision can arrive while the previous attempt is returning from
            // Waiting. Coalescing a wakeup prevents that handoff from losing it.
            entry.channel = channel;
            entry.pending = true;
            return Ok(());
        }
        let permit = self
            .0
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error("The runtime worker capacity is exhausted."))?;
        let run = channel.run_id().to_owned();
        let owner = Uuid::new_v4();
        let stop = Cancellation::default();
        active.insert(
            run.clone(),
            Entry {
                owner,
                channel,
                pending: true,
                stop: stop.clone(),
            },
        );
        let host = self.clone();
        tokio::spawn(async move {
            let _guard = Attempt {
                host: host.clone(),
                run: run.clone(),
                owner,
                _permit: permit,
            };
            loop {
                let channel = {
                    let Ok(mut active) = host.0.active.lock() else {
                        break;
                    };
                    let Some(entry) = active.get_mut(&run).filter(|v| v.owner == owner) else {
                        break;
                    };
                    if !entry.pending || stop.is_cancelled() {
                        break;
                    }
                    entry.pending = false;
                    entry.channel.clone()
                };
                let _ = host.0.worker.run(&channel, None, &stop).await;
                // Decide and remove under one lock, so a successful kick cannot
                // race between the final pending check and registry removal.
                let Ok(mut active) = host.0.active.lock() else {
                    break;
                };
                if active
                    .get(&run)
                    .is_some_and(|e| e.owner == owner && e.pending)
                    && !stop.is_cancelled()
                {
                    continue;
                }
                if active.get(&run).is_some_and(|e| e.owner == owner) {
                    active.remove(&run);
                }
                break;
            }
        });
        Ok(())
    }
    /// The caller first persists cancellation, which also fences other hosts.
    pub fn stop(&self, run: &str) {
        if let Ok(active) = self.0.active.lock()
            && let Some(entry) = active.get(run)
        {
            entry.stop.cancel();
        }
    }
    /// Graceful process shutdown releases leases but does not cancel durable runs.
    pub async fn shutdown(&self) -> Result<()> {
        self.0.stopping.cancel();
        if let Ok(active) = self.0.active.lock() {
            for entry in active.values() {
                entry.stop.cancel();
            }
        }
        timeout(Duration::from_secs(10), async {
            loop {
                let notified = self.0.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self.0.active.lock().is_ok_and(|active| active.is_empty()) {
                    break;
                }
                notified.await;
            }
        })
        .await
        .map_err(|_| Error("The runtime host could not finish shutdown."))
    }
}
struct Attempt {
    host: Host,
    run: String,
    owner: Uuid,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
impl Drop for Attempt {
    fn drop(&mut self) {
        if let Ok(mut active) = self.host.0.active.lock()
            && active
                .get(&self.run)
                .is_some_and(|entry| entry.owner == self.owner)
        {
            active.remove(&self.run);
        }
        self.host.0.changed.notify_waiters();
    }
}
