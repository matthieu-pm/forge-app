use super::*;
use crate::jobs::{
    self, Code, Enqueue, Error, JobStore, Lease,
    runner::{self, Handler, RunError},
};
use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
pub const KIND: &str = "sla-breach-v1";
fn failed<E>(_: E) -> Error {
    Code::JobFailed.into()
}
pub async fn dispatch(db: &Database, store: &JobStore) -> jobs::Result<usize> {
    let pending:Vec<(Uuid,String,String,DateTime<Utc>)>=sqlx::query_as("SELECT g.id,g.workspace_id,g.deadline_at::text,g.deadline_at FROM issue_sla_intents i JOIN issue_slas g ON g.id=i.commitment_id WHERE i.job_id IS NULL ORDER BY i.created_at,g.id LIMIT 100").fetch_all(db.pool()).await.map_err(failed)?;
    for (id, workspace, deadline, scheduled) in &pending {
        let job = store
            .enqueue(&Enqueue {
                kind: KIND.into(),
                scope: format!("{:x}", Sha256::digest(workspace)),
                identity: id.to_string(),
                scheduled_at: *scheduled,
                max_attempts: 5,
                input: json!({"commitmentId":id,"workspaceId":workspace,"deadline":deadline}),
            })
            .await?;
        let mut tx = db.begin().await.map_err(failed)?;
        tx.prepare().await.map_err(failed)?;
        sqlx::query(
            "UPDATE issue_sla_intents SET job_id=$2 WHERE commitment_id=$1 AND job_id IS NULL",
        )
        .bind(id)
        .bind(job)
        .execute(&mut *tx)
        .await
        .map_err(failed)?;
        tx.commit().await.map_err(failed)?;
    }
    Ok(pending.len())
}
#[derive(sqlx::FromRow)]
struct Observed {
    policy_enabled: bool,
    gate_uncertain: bool,
    owed: bool,
    breached: bool,
    running: bool,
    current: bool,
    can_reopen: bool,
}
async fn lock_sla(
    db: &Database,
    tx: &mut PgConnection,
    id: Uuid,
    workspace: &str,
) -> jobs::Result<Option<(bool, Observed)>> {
    let exists: Option<String> =
        sqlx::query_scalar("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
            .bind(workspace)
            .fetch_optional(&mut *tx)
            .await
            .map_err(failed)?;
    if exists.is_none() {
        return Ok(None);
    }
    let issue: Option<Uuid> =
        sqlx::query_scalar("SELECT issue_id FROM issue_slas WHERE id=$1 AND workspace_id=$2")
            .bind(id)
            .bind(workspace)
            .fetch_optional(&mut *tx)
            .await
            .map_err(failed)?;
    let Some(issue) = issue else {
        return Ok(None);
    };
    let purged: Option<bool> = sqlx::query_scalar(
        "SELECT purged_at IS NOT NULL FROM issues WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
    )
    .bind(issue)
    .bind(workspace)
    .fetch_optional(&mut *tx)
    .await
    .map_err(failed)?;
    if purged != Some(false) {
        return Ok(None);
    }
    sqlx::query("SELECT workspace_id FROM sla_policies WHERE workspace_id=$1 FOR SHARE")
        .bind(workspace)
        .execute(&mut *tx)
        .await
        .map_err(failed)?;
    let gate = configure(db, tx, workspace).await.map_err(failed)?;
    sqlx::query("SELECT forge_sla_touch($1,clock_timestamp())")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(failed)?;
    let observed:Observed=sqlx::query_as("SELECT coalesce((p.values->>'enabled')::boolean,false) policy_enabled,g.gate_uncertain,g.owed_at IS NOT NULL owed,EXISTS(SELECT 1 FROM issue_sla_events e WHERE e.commitment_id=g.id AND e.kind='breached') breached,g.state='running' running,g.current,g.state='completed' AND g.completed_at>clock_timestamp()-interval '720 hours' can_reopen FROM issue_slas g LEFT JOIN sla_policies p ON p.workspace_id=g.workspace_id WHERE g.id=$1 FOR UPDATE OF g").bind(id).fetch_one(&mut *tx).await.map_err(failed)?;
    Ok(Some((gate.0, observed)))
}
pub struct BreachJob;
#[async_trait::async_trait]
impl Handler for BreachJob {
    async fn run(&self, store: &JobStore, lease: &Lease) -> Result<(), RunError> {
        let id = lease.input["commitmentId"]
            .as_str()
            .filter(|s| s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
            .ok_or(Error::permanent(Code::InvalidInput))?;
        // The source's loose syntax check lets malformed UUID layouts fail at SQL.
        let id = id
            .parse::<Uuid>()
            .map_err(|_| Error::from(Code::JobFailed))?;
        let workspace = lease.input["workspaceId"]
            .as_str()
            .ok_or(Error::permanent(Code::InvalidInput))?
            .to_owned();
        let db = store.database().clone();
        let gate = db.sla_gate(&workspace);
        let w = workspace.clone();
        store
            .sql_step(lease, &format!("gate:{}:{}", gate.1, gate.0), move |tx| {
                Box::pin(
                    async move { Ok(json!({"present":lock_sla(&db,tx,id,&w).await?.is_some()})) },
                )
            })
            .await?;
        let db = store.database().clone();
        store
            .sql_step_control::<RunError, _>(lease, "breach", move |tx| {
                Box::pin(async move {
                    let Some((enabled, state)) = lock_sla(&db, tx, id, &workspace).await? else {
                        return Ok(json!({"state":"gone"}));
                    };
                    if !enabled || !state.policy_enabled || (state.gate_uncertain && state.owed) {
                        return Err(RunError::Deferred);
                    }
                    let emitted: bool =
                        sqlx::query_scalar("SELECT forge_sla_breach($1,clock_timestamp())")
                            .bind(id)
                            .fetch_one(&mut *tx)
                            .await
                            .map_err(failed)?;
                    if !emitted
                        && !state.breached
                        && ((state.running && state.current) || state.can_reopen)
                    {
                        return Err(RunError::Deferred);
                    }
                    Ok(json!({"state":if emitted || state.breached{"breached"}else{"closed"}}))
                })
            })
            .await?;
        Ok(())
    }
}
pub async fn run_jobs(db: &Database, store: &JobStore) -> jobs::Result<Value> {
    let dispatched = dispatch(db, store).await?;
    let mut results = Vec::new();
    for _ in 0..20 {
        let result = runner::run_next(store, KIND, &BreachJob, None).await?;
        if result["state"] == "idle" {
            break;
        }
        results.push(result);
    }
    Ok(json!({"dispatched":dispatched,"results":results}))
}
