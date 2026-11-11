use super::*;
use crate::{StoreError, authority, security, workspaces::lock_workspace};
use forge_core::{
    actor::{Actor, Authentication},
    security::SecurityAction,
};

pub async fn start(
    database: &Database,
    actor: &Actor,
    invitation: &str,
) -> std::result::Result<Value, StoreError> {
    reserve(database, actor, Some(invitation), None).await
}
pub async fn retry(
    database: &Database,
    actor: &Actor,
    run: Uuid,
) -> std::result::Result<Value, StoreError> {
    reserve(database, actor, None, Some(run)).await
}
async fn reserve(
    database: &Database,
    actor: &Actor,
    invitation: Option<&str>,
    run: Option<Uuid>,
) -> std::result::Result<Value, StoreError> {
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let live = authority::current_actor(&mut tx, actor).await?;
    if !matches!(live.authentication, Authentication::Session { .. })
        || !live.has_role(&["owner", "admin"])
    {
        return Err(StoreError::Forbidden);
    }
    // Starting from an invite uses current invite policy. Retrying an already
    // reserved workflow follows the source owner/admin route; delivery rechecks
    // the original inviter and policy before performing any external effect.
    if invitation.is_some()
        && !security::settings(&mut tx, &live.workspace_id)
            .await?
            .allows(&live, SecurityAction::MembersInvite)
    {
        return Err(StoreError::Forbidden);
    }
    tx.prepare().await?;
    let run = if let Some(invitation) = invitation {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM invitation WHERE id=$1 AND organization_id=$2)",
        )
        .bind(invitation)
        .bind(&live.workspace_id)
        .fetch_one(&mut *tx)
        .await?;
        if !exists {
            return Err(StoreError::NotFound);
        }
        let key = format!("workspace-invitation:v1:{invitation}");
        sqlx::query("INSERT INTO business_workflow_runs(workspace_id,kind,subject_type,subject_id,idempotency_key) VALUES($1,$2,'invitation',$3,$4) ON CONFLICT(idempotency_key) DO NOTHING")
            .bind(&live.workspace_id).bind(KIND).bind(invitation).bind(&key).execute(&mut *tx).await?;
        sqlx::query_scalar("SELECT id FROM business_workflow_runs WHERE idempotency_key=$1 AND workspace_id=$2 AND kind=$3 AND subject_type='invitation' AND subject_id=$4")
            .bind(key).bind(&live.workspace_id).bind(KIND).bind(invitation).fetch_optional(&mut *tx).await?.ok_or(StoreError::Conflict)?
    } else {
        run.ok_or(StoreError::InvalidInput)?
    };
    let (state,sdk,created): (String,Option<String>,DateTime<Utc>) = sqlx::query_as("SELECT state,sdk_run_id,created_at FROM business_workflow_runs WHERE id=$1 AND workspace_id=$2 AND kind=$3 AND subject_type='invitation' FOR UPDATE")
        .bind(run).bind(&live.workspace_id).bind(KIND).fetch_optional(&mut *tx).await?.ok_or(StoreError::NotFound)?;
    let already_native = if let Some(native) = sdk
        .as_deref()
        .and_then(|id| id.strip_prefix("forge-native-job:"))
    {
        let job = Uuid::parse_str(native).map_err(|_| StoreError::Conflict)?;
        let state: Option<String> = sqlx::query_scalar("SELECT state FROM background_jobs WHERE id=$1 AND kind=$2 AND scope=$3 AND identity=$4")
            .bind(job).bind(KIND).bind(&live.workspace_id).bind(run.to_string()).fetch_optional(&mut *tx).await?;
        match state.as_deref() {
            Some("queued" | "running" | "retry" | "completed") => true,
            _ => return Err(StoreError::Conflict),
        }
    } else {
        false
    };
    if !already_native && !matches!(state.as_str(), "running" | "completed") {
        if !forge_core::invitations::can_start(sdk.as_deref(), &state) {
            return Err(StoreError::Conflict);
        }
        let job = JobStore::enqueue_in(
            &mut tx,
            &Enqueue {
                kind: KIND.into(),
                scope: live.workspace_id.clone(),
                identity: run.to_string(),
                scheduled_at: created,
                max_attempts: 20,
                input: serde_json::to_value(Input {
                    business_run_id: run,
                    workspace_id: live.workspace_id,
                })
                .map_err(|_| StoreError::InvalidInput)?,
            },
        )
        .await?;
        sqlx::query("UPDATE business_workflow_runs SET sdk_run_id=$2,state='queued',start_attempts=start_attempts+1,failure_code=NULL,completed_at=NULL,updated_at=clock_timestamp() WHERE id=$1")
            .bind(run).bind(owner(job)).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(json!({"state":"queued","businessRunId":run}))
}
