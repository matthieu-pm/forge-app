//! Native ownership of the existing invitation business/effect ledger. A single
//! fenced job yields between lifecycle stages; no worker sleeps for 24 hours.
mod delivery;
mod queue;
use super::*;
use chrono::{DateTime, Duration, Utc};
use forge_core::invitations::{Decision, DeliveryError, Effect};
pub use queue::{retry, start};
use serde::{Deserialize, Serialize};
use serde_json::json;

pub const KIND: &str = "workspace-invitation-lifecycle-v1";
fn owner(id: Uuid) -> String {
    format!("forge-native-job:{id}")
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Invitation {
    pub id: String,
    pub email: String,
    pub role: String,
    pub organization_name: String,
    pub inviter_name: String,
    pub inviter_email: String,
}
#[async_trait::async_trait]
pub trait Transport: Send + Sync {
    /// Hash the exact provider payload, including sender and application URL.
    /// Only this digest is persisted; email content is never a job checkpoint.
    fn fingerprint(
        &self,
        invitation: &Invitation,
        effect: Effect,
    ) -> std::result::Result<String, DeliveryError>;
    async fn deliver(
        &self,
        invitation: &Invitation,
        effect: Effect,
    ) -> std::result::Result<String, DeliveryError>;
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    business_run_id: Uuid,
    workspace_id: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    decision: Decision,
    expires_at: DateTime<Utc>,
    completed_at: DateTime<Utc>,
}
#[derive(Debug)]
struct Failure {
    error: Error,
    retry_seconds: Option<i32>,
}
impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        Self {
            error,
            retry_seconds: None,
        }
    }
}
impl From<Code> for Failure {
    fn from(code: Code) -> Self {
        Error::from(code).into()
    }
}
impl From<DeliveryError> for Failure {
    fn from(error: DeliveryError) -> Self {
        Self {
            error: Error {
                code: Code::JobFailed,
                permanent: !error.retryable,
            },
            retry_seconds: error.retry_after().map(|delay| delay.num_seconds() as i32),
        }
    }
}
async fn now(tx: &mut PgConnection) -> Result<DateTime<Utc>> {
    sqlx::query_scalar("SELECT date_trunc('milliseconds',clock_timestamp())")
        .fetch_one(tx)
        .await
        .map_err(failed)
}
async fn owned(tx: &mut PgConnection, lease: &Lease, input: &Input) -> Result<String> {
    // The public subject ID and a serialized job input are not authority grants.
    let state: Option<String> = sqlx::query_scalar("SELECT r.state FROM business_workflow_runs r JOIN background_jobs j ON j.id=$1 WHERE r.id=$2 AND r.workspace_id=$3 AND r.kind=$4 AND r.subject_type='invitation' AND r.sdk_run_id=$5 AND j.kind=$4 AND j.scope=r.workspace_id AND j.identity=r.id::text FOR UPDATE OF r")
        .bind(lease.id).bind(input.business_run_id).bind(&input.workspace_id).bind(KIND).bind(owner(lease.id)).fetch_optional(tx).await.map_err(failed)?;
    state.ok_or(Error::permanent(Code::IdentityConflict))
}
async fn checkpoint(
    tx: &mut PgConnection,
    lease: &Lease,
    key: &str,
    receipt: &Receipt,
) -> Result<()> {
    let body = super::json(&serde_json::to_value(receipt).map_err(failed)?)?;
    sqlx::query("INSERT INTO background_job_steps(job_id,key,mode,state,result) VALUES($1,$2,'transactional','completed',$3::jsonb)")
        .bind(lease.id).bind(key).bind(body).execute(tx).await.map_err(failed)?;
    Ok(())
}

/// Execute at most the currently due stages. Recovering a dead/reconcile job
/// remains an explicit operator action through the existing jobs CLI.
pub async fn run_next(
    store: &JobStore,
    transport: &dyn Transport,
    id: Option<Uuid>,
) -> Result<Value> {
    store.reap(Some(KIND), id).await?;
    sync_failures(store, id).await?;
    let Some(lease) = store.claim(KIND, id).await? else {
        return Ok(json!({"state":"idle"}));
    };
    let input: Input = match serde_json::from_value(lease.input.clone()) {
        Ok(input) => input,
        Err(_) => {
            let state = store
                .fail(&lease, Error::permanent(Code::InvalidInput))
                .await?;
            sync_failures(store, Some(lease.id)).await?;
            return Ok(json!({"state":state,"id":lease.id}));
        }
    };
    let result = execute(store, &lease, &input, transport).await;
    let state = match result {
        Ok(Some(until)) => {
            let mut tx = store.transaction().await?;
            JobStore::fence(&mut tx, &lease, true).await?;
            sqlx::query("UPDATE background_jobs SET state='queued',available_at=$2,attempts=greatest(0,attempts-1),lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1")
                .bind(lease.id).bind(until).execute(&mut *tx).await.map_err(failed)?;
            tx.commit().await.map_err(failed)?;
            "deferred".to_owned()
        }
        Ok(None) => match store.complete(&lease).await {
            Ok(()) => "completed".into(),
            Err(error) if error.code == Code::LeaseLost => "lost".into(),
            Err(error) => fail(store, &lease, Failure::from(error)).await?,
        },
        Err(error) if error.error.code == Code::LeaseLost => "lost".into(),
        Err(error) => fail(store, &lease, error).await?,
    };
    sync_failures(store, Some(lease.id)).await?;
    Ok(json!({"state":state,"id":lease.id}))
}

async fn fail(store: &JobStore, lease: &Lease, error: Failure) -> Result<String> {
    // Keep the ledger's reconciliation precedence, with source mail retry delays.
    let mut tx = store.transaction().await?;
    JobStore::fence(&mut tx, lease, true).await?;
    let state: String = sqlx::query_scalar("UPDATE background_jobs j SET state=CASE WHEN $2 OR EXISTS(SELECT 1 FROM background_job_steps s WHERE s.job_id=j.id AND s.state='started' AND (s.mode='reconcile' OR s.idempotency_until<=clock_timestamp())) THEN 'reconcile' WHEN $3 OR attempts>=max_attempts THEN 'dead' ELSE 'retry' END,failure_code=$4,available_at=clock_timestamp()+make_interval(secs=>$5),lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING state")
        .bind(lease.id).bind(error.error.code==Code::ReconciliationRequired).bind(error.error.permanent).bind(error.error.code.to_string()).bind(error.retry_seconds.unwrap_or(5)).fetch_one(&mut *tx).await.map_err(failed)?;
    tx.commit().await.map_err(failed)?;
    Ok(state)
}
async fn sync_failures(store: &JobStore, id: Option<Uuid>) -> Result<()> {
    let mut tx = store.transaction().await?;
    sqlx::query("UPDATE business_workflow_runs r SET state='failed',failure_code='workflow_execution_failed',completed_at=clock_timestamp(),updated_at=clock_timestamp() FROM background_jobs j WHERE j.kind=$1 AND ($2::uuid IS NULL OR j.id=$2) AND j.state IN ('dead','reconcile') AND r.sdk_run_id='forge-native-job:'||j.id::text AND r.kind=$1 AND r.state IN ('queued','starting','running')")
        .bind(KIND).bind(id).execute(&mut *tx).await.map_err(failed)?;
    tx.commit().await.map_err(failed)
}
async fn execute(
    store: &JobStore,
    lease: &Lease,
    input: &Input,
    transport: &dyn Transport,
) -> std::result::Result<Option<DateTime<Utc>>, Failure> {
    let mut tx = store.transaction().await?;
    JobStore::fence(&mut tx, lease, true).await?;
    let state = owned(&mut tx, lease, input).await?;
    if matches!(state.as_str(), "completed" | "cancelled") {
        tx.commit().await.map_err(failed)?;
        return Ok(None);
    }
    sqlx::query("UPDATE business_workflow_runs SET state='running',started_at=coalesce(started_at,clock_timestamp()),completed_at=NULL,failure_code=NULL,updated_at=clock_timestamp() WHERE id=$1")
        .bind(input.business_run_id).execute(&mut *tx).await.map_err(failed)?;
    tx.commit().await.map_err(failed)?;
    let initial = delivery::run(store, lease, input, Effect::Initial, transport).await?;
    if initial.decision == Decision::Deliver {
        let until = initial.completed_at + Duration::hours(24);
        if is_future(store, lease, until).await? {
            return Ok(Some(until));
        }
        let reminder = delivery::run(store, lease, input, Effect::Reminder, transport).await?;
        if reminder.decision == Decision::Deliver
            && is_future(store, lease, initial.expires_at).await?
        {
            return Ok(Some(initial.expires_at));
        }
        if reminder.decision == Decision::Deliver {
            let input = input.clone();
            store.sql_step(lease,"expire",move |tx|Box::pin(async move {
                sqlx::query("UPDATE invitation i SET status='expired' FROM business_workflow_runs r WHERE r.id=$1 AND r.workspace_id=$2 AND r.subject_type='invitation' AND r.subject_id=i.id AND i.organization_id=r.workspace_id AND i.status='pending' AND i.expires_at<=clock_timestamp()")
                    .bind(input.business_run_id).bind(input.workspace_id).execute(tx).await.map_err(failed)?;
                Ok(Value::Null)
            })).await?;
        }
    }
    let mut tx = store.transaction().await?;
    JobStore::fence(&mut tx, lease, true).await?;
    owned(&mut tx, lease, input).await?;
    let pending: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM background_job_steps WHERE job_id=$1 AND state<>'completed')",
    )
    .bind(lease.id)
    .fetch_one(&mut *tx)
    .await
    .map_err(failed)?;
    if pending {
        return Err(Code::ReconciliationRequired.into());
    }
    sqlx::query("UPDATE business_workflow_runs SET state='completed',completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1")
        .bind(input.business_run_id).execute(&mut *tx).await.map_err(failed)?;
    tx.commit().await.map_err(failed)?;
    Ok(None)
}
async fn is_future(store: &JobStore, lease: &Lease, until: DateTime<Utc>) -> Result<bool> {
    let mut tx = store.transaction().await?;
    JobStore::fence(&mut tx, lease, true).await?;
    let future = until > now(&mut tx).await?;
    tx.commit().await.map_err(failed)?;
    Ok(future)
}
