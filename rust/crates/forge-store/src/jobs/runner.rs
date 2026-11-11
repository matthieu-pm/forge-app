use super::*;
use async_trait::async_trait;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("Job deferred")]
    Deferred,
    #[error(transparent)]
    Failed(#[from] Error),
}
#[async_trait]
pub trait Handler: Send + Sync {
    async fn run(&self, store: &JobStore, lease: &Lease) -> std::result::Result<(), RunError>;
}
/// The observer receives only sanitized operational fields, never the input or
/// provider exception. A host may connect this to its telemetry transport.
pub trait Observer: Send + Sync {
    fn event(&self, name: &'static str, data: Value);
}
pub struct Silent;
impl Observer for Silent {
    fn event(&self, _: &'static str, _: Value) {}
}

pub async fn run_next(
    store: &JobStore,
    kind: &str,
    handler: &dyn Handler,
    id: Option<Uuid>,
) -> Result<Value> {
    run_observed(store, kind, handler, id, &Silent).await
}
pub async fn run_observed(
    store: &JobStore,
    kind: &str,
    handler: &dyn Handler,
    id: Option<Uuid>,
    observer: &dyn Observer,
) -> Result<Value> {
    let Some(lease) = store.claim(kind, id).await? else {
        return Ok(json!({"state":"idle"}));
    };
    observer.event(
        "lease.acquired",
        json!({"jobId":lease.id,"attempt":lease.attempt,"queueAgeMs":lease.queue_age_ms}),
    );
    let result = match handler.run(store, &lease).await {
        Ok(()) => store.complete(&lease).await.map_err(RunError::from),
        Err(e) => Err(e),
    };
    let state = match result {
        Ok(()) => {
            observer.event(
                "operation.completed",
                json!({"jobId":lease.id,"attempt":lease.attempt}),
            );
            "completed".to_owned()
        }
        Err(RunError::Deferred) => match store.defer(&lease).await {
            Ok(()) => "deferred".into(),
            Err(e) if e.code == Code::LeaseLost => "lost".into(),
            Err(e) => return Err(e),
        },
        Err(RunError::Failed(e)) if e.code == Code::LeaseLost => {
            observer.event(
                "operation.rejected",
                json!({"jobId":lease.id,"errorCode":"JOB_LEASE_LOST"}),
            );
            "lost".into()
        }
        Err(RunError::Failed(e)) => match store.fail(&lease, e).await {
            Ok(state) => {
                observer.event("operation.failed",json!({"jobId":lease.id,"errorCode":if state == State::Reconcile { "JOB_RECONCILIATION_REQUIRED" } else { "JOB_FAILED" },"attempt":lease.attempt,"failures":1}));
                serde_json::to_value(state)
                    .map_err(failed)?
                    .as_str()
                    .ok_or(Code::JobFailed)?
                    .into()
            }
            Err(e) if e.code == Code::LeaseLost => "lost".into(),
            Err(_) => return Err(Code::JobFailed.into()),
        },
    };
    Ok(json!({"state":state,"id":lease.id}))
}
