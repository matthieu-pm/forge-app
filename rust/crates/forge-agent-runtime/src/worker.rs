//! One leased worker attempt. The hosting service owns/spawns this future;
//! disconnecting a reader must not drop it. Tokens remain in memory only, so
//! recovery after process death requires a newly authenticated owner request.
use crate::{
    Error, Result,
    auth::Channel,
    engine::{Decision, Engine, Phase, State},
    journal::{Lease, Store},
    sandbox::Cancellation,
};
use async_trait::async_trait;
use chrono::Utc;
use std::{sync::Arc, time::Duration};
use tokio::time::{Instant, sleep, sleep_until, timeout};
use uuid::Uuid;

#[async_trait]
pub trait Factory: Send + Sync {
    /// Create resources for this run only, after acquiring its durable lease.
    /// Implementations must release resources when this future/engine is dropped.
    async fn create(
        &self,
        channel: &Channel,
        state: &State,
        cancellation: &Cancellation,
    ) -> Result<Engine>;
}
pub struct Response {
    pub request: String,
    pub decision: Decision,
}
#[derive(Clone, Copy)]
pub struct Options {
    pub lease_ttl: Duration,
    pub heartbeat_interval: Duration,
    pub database_timeout: Duration,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            lease_ttl: Duration::from_secs(30),
            heartbeat_interval: Duration::from_secs(5),
            database_timeout: Duration::from_secs(5),
        }
    }
}
pub struct Worker {
    store: Store,
    factory: Arc<dyn Factory>,
    options: Options,
}
impl Worker {
    pub fn new(store: Store, factory: Arc<dyn Factory>, options: Options) -> Result<Self> {
        if options.lease_ttl < Duration::from_secs(1)
            || options.lease_ttl > Duration::from_secs(60)
            || options.heartbeat_interval < Duration::from_millis(100)
            || options.database_timeout < Duration::from_millis(100)
            || options
                .heartbeat_interval
                .saturating_add(options.database_timeout)
                >= options.lease_ttl
        {
            return Err(Error("Invalid runtime worker timing configuration."));
        }
        Ok(Self {
            store,
            factory,
            options,
        })
    }
    pub async fn run(
        &self,
        channel: &Channel,
        response: Option<Response>,
        shutdown: &Cancellation,
    ) -> Result<Phase> {
        // The source verifier permits credentials without exp for compatibility;
        // unattended native workers additionally require a finite signed expiry.
        let seconds = channel
            .expires_at()
            .ok_or(Error("A bounded runtime credential is required."))?
            - Utc::now().timestamp_millis() as f64 / 1000.;
        let remaining = Duration::try_from_secs_f64(seconds)
            .ok()
            .filter(|v| !v.is_zero())
            .ok_or(Error("The runtime credential has expired."))?;
        let authorized_until = Instant::now() + remaining.min(Duration::from_secs(900));
        tokio::select! {
            biased;
            () = shutdown.cancelled() => Err(Error("The runtime worker is shutting down.")),
            () = sleep_until(authorized_until) => Err(Error("The runtime credential has expired.")),
            result = self.run_authorized(channel, response, authorized_until, shutdown) => result,
        }
    }
    async fn run_authorized(
        &self,
        channel: &Channel,
        response: Option<Response>,
        authorized_until: Instant,
        shutdown: &Cancellation,
    ) -> Result<Phase> {
        let session = timeout(self.options.database_timeout, self.store.load(channel))
            .await
            .map_err(|_| Error("The runtime journal is unavailable."))??;
        if session.cancelled {
            return Err(Error("The agent run has been cancelled."));
        }
        // A repeated response is accepted only when its exact decision has a
        // durable receipt. Conflicts/stale IDs cannot allocate run resources.
        if let Some(response) = &response {
            match session.state.decision(&response.request) {
                Some(recorded) if recorded == response.decision => {}
                None if session.state.pending_request() == Some(response.request.as_str()) => {}
                _ => {
                    return Err(Error(
                        "The approval response is stale or conflicts with its recorded decision.",
                    ));
                }
            }
        }
        if matches!(
            session.state.phase(),
            Phase::Complete | Phase::Cancelled | Phase::Failed
        ) || (session.state.phase() == Phase::Waiting
            && response
                .as_ref()
                .is_none_or(|r| session.state.decision(&r.request).is_some()))
        {
            return Ok(session.state.phase());
        }
        let remaining = (session.deadline - Utc::now())
            .to_std()
            .ok()
            .filter(|v| !v.is_zero())
            .ok_or(Error("The agent run deadline has elapsed."))?;
        let deadline =
            (Instant::now() + remaining.min(Duration::from_secs(900))).min(authorized_until);
        let (lease, mut state) = timeout(
            self.options.database_timeout,
            self.store
                .acquire(channel, Uuid::new_v4(), self.options.lease_ttl),
        )
        .await
        .map_err(|_| Error("The runtime journal is unavailable."))??;
        let mut guard = Guard {
            lease: Some(Arc::new(lease)),
            cancellation: Cancellation::default(),
        };
        let lease = guard.lease.as_ref().unwrap().clone();
        let result = {
            // Every branch drops the factory/model/tool future before releasing
            // ownership. Heartbeat failure never leaves detached execution.
            let execution = async {
                let engine = self
                    .factory
                    .create(channel, &state, &guard.cancellation)
                    .await?;
                if let Some(response) = response {
                    engine
                        .resume(
                            channel,
                            &mut state,
                            &*lease,
                            &response.request,
                            response.decision,
                        )
                        .await?;
                }
                engine
                    .drive(channel, &mut state, &*lease, &guard.cancellation, deadline)
                    .await
            };
            tokio::select! {
                biased;
                () = shutdown.cancelled() => Err(Error("The runtime worker is shutting down.")),
                () = sleep_until(deadline) => Err(Error("The runtime worker deadline has elapsed.")),
                result = self.heartbeat(&lease) => result,
                result = execution => result,
            }
        };
        guard.cancellation.cancel();
        // Durable completion is authoritative even if release acknowledgement
        // is lost. A failed release remains bounded by the lease's expiration.
        if timeout(self.options.database_timeout, lease.release())
            .await
            .is_ok_and(|v| v.is_ok())
        {
            guard.lease = None;
        }
        result
    }
    async fn heartbeat(&self, lease: &Lease) -> Result<Phase> {
        loop {
            sleep(self.options.heartbeat_interval).await;
            timeout(self.options.database_timeout, lease.renew())
                .await
                .map_err(|_| Error("The runtime worker could not renew its lease."))??;
        }
    }
}
struct Guard {
    lease: Option<Arc<Lease>>,
    cancellation: Cancellation,
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if let Some(lease) = self.lease.take()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            runtime.spawn(async move {
                let _ = timeout(Duration::from_secs(5), lease.release()).await;
            });
        }
    }
}
