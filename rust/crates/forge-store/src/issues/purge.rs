//! Bounded, restartable removal after the issue's fixed recovery deadline.
//! Storage references survive failed byte deletion; the committed purge marker
//! fences ordinary writes before any source-bound copy is drained.
use crate::{Database, StoreError, database::JournalTransaction};
use forge_core::{files::upload::Transport, product_state::copies};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

#[derive(Default, Debug, Serialize)]
pub struct Counts {
    pub purged: u64,
    pub failed: u64,
}
#[derive(Debug, Serialize)]
pub struct Report {
    pub purged: u64,
    pub failed: u64,
    pub pending: bool,
}
async fn transaction(db: &Database) -> Result<JournalTransaction, StoreError> {
    let mut tx = db.begin().await?;
    tx.prepare().await?;
    Ok(tx)
}
async fn fence(tx: &mut JournalTransaction, workspace: &str) -> Result<(), StoreError> {
    sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
        .bind(workspace)
        .execute(&mut **tx)
        .await?;
    Ok(())
}
async fn change(
    db: &Database,
    statement: &str,
    workspace: &str,
    issue: Uuid,
) -> Result<u64, StoreError> {
    let mut tx = transaction(db).await?;
    let rows = sqlx::query(statement)
        .bind(workspace)
        .bind(issue)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    tx.commit().await?;
    Ok(rows)
}
async fn remove_row(
    db: &Database,
    statement: &str,
    id: Uuid,
    workspace: &str,
) -> Result<(), StoreError> {
    let mut tx = transaction(db).await?;
    sqlx::query(statement)
        .bind(id)
        .bind(workspace)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}
pub async fn purge(db: &Database, blobs: &dyn Transport, limit: i64) -> Result<Counts, StoreError> {
    if !(1..=100).contains(&limit) {
        return Err(StoreError::InvalidInput);
    }
    let due:Vec<(Uuid,String)>=sqlx::query_as("SELECT id,workspace_id FROM issues WHERE deleted_at+interval '720 hours'<=clock_timestamp() AND purged_at IS NULL AND (purge_lease_until IS NULL OR purge_lease_until<clock_timestamp()) ORDER BY deleted_at,id LIMIT $1").bind(limit).fetch_all(db.pool()).await?;
    let mut counts = Counts::default();
    for (id, workspace) in due {
        let token = Uuid::new_v4();
        let mut tx = transaction(db).await?;
        fence(&mut tx, &workspace).await?;
        let claimed:Option<Uuid>=sqlx::query_scalar("UPDATE issues SET purge_started_at=coalesce(purge_started_at,clock_timestamp()),purge_lease_until=clock_timestamp()+interval '10 minutes',purge_token=$2,purge_attempts=purge_attempts+1,purge_error=NULL WHERE id=$1 AND purged_at IS NULL AND deleted_at+interval '720 hours'<=clock_timestamp() AND (purge_lease_until IS NULL OR purge_lease_until<clock_timestamp()) RETURNING id").bind(id).bind(token).fetch_optional(&mut *tx).await?;
        tx.commit().await?;
        if claimed.is_none() {
            continue;
        }
        match drain(db, blobs, id, &workspace, token).await {
            Ok(true) => counts.purged += 1,
            Ok(false) => {}
            Err(_) => {
                counts.failed += 1;
                let mut tx = transaction(db).await?;
                sqlx::query("UPDATE issues SET purge_error='Issue purge failed; retry pending.',purge_lease_until=clock_timestamp()+interval '5 minutes',purge_token=NULL WHERE id=$1 AND purge_token=$2").bind(id).bind(token).execute(&mut *tx).await?;
                tx.commit().await?;
            }
        }
    }
    Ok(counts)
}
async fn drain(
    db: &Database,
    blobs: &dyn Transport,
    id: Uuid,
    workspace: &str,
    token: Uuid,
) -> Result<bool, StoreError> {
    let files:Vec<(Uuid,String)>=sqlx::query_as("SELECT id,storage_reference FROM resource_files WHERE workspace_id=$1 AND (issue_id=$2 OR document_id IN (SELECT id FROM documents WHERE workspace_id=$1 AND issue_id=$2 AND NOT shared_with_workspace)) LIMIT 100").bind(workspace).bind(id).fetch_all(db.pool()).await?;
    for (file, reference) in &files {
        blobs.delete(reference).await?;
        remove_row(
            db,
            "DELETE FROM resource_files WHERE id=$1 AND workspace_id=$2",
            *file,
            workspace,
        )
        .await?;
    }
    let intents:Vec<(Uuid,String)>=sqlx::query_as("SELECT id,storage_reference FROM file_upload_intents WHERE workspace_id=$1 AND ((target->>'kind'='issue' AND target->>'id'=$2::uuid::text) OR (target->>'kind'='document' AND target->>'id' IN (SELECT id::text FROM documents WHERE issue_id=$2 AND workspace_id=$1 AND NOT shared_with_workspace))) LIMIT 100").bind(workspace).bind(id).fetch_all(db.pool()).await?;
    for (intent, reference) in &intents {
        blobs.delete(reference).await?;
        remove_row(
            db,
            "DELETE FROM file_upload_intents WHERE id=$1 AND workspace_id=$2",
            *intent,
            workspace,
        )
        .await?;
    }
    let pending_loops = loop_copies(db, blobs, id, workspace).await?;
    let mut tx = transaction(db).await?;
    fence(&mut tx, workspace).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,4040))")
        .bind(workspace)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT public.forge_lock_issue_graph($1)")
        .bind(workspace)
        .execute(&mut *tx)
        .await?;
    let row: Option<(Option<Uuid>,)> = sqlx::query_as(
        "SELECT purge_copy_cursor FROM issues WHERE id=$1 AND purge_token=$2 FOR UPDATE",
    )
    .bind(id)
    .bind(token)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((cursor,)) = row else {
        tx.commit().await?;
        return Ok(false);
    };
    if files.len() == 100 || intents.len() == 100 || pending_loops {
        release(&mut tx, id).await?;
        tx.commit().await?;
        return Ok(false);
    }
    let patterns: Vec<String> = copies::PREFIXES.iter().map(|p| format!("{p}%")).collect();
    let rows:Vec<(Uuid,String,Option<String>,i32)>=sqlx::query_as("SELECT id,key,encoded_value,revision FROM product_state WHERE workspace_id=$1 AND key LIKE ANY($2) AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 5 FOR UPDATE").bind(workspace).bind(patterns).bind(cursor).fetch_all(&mut *tx).await?;
    let target = id.to_string();
    for (copy, key, encoded, revision) in &rows {
        let Some(encoded) = encoded else {
            continue;
        };
        let filtered = (|| {
            let value = forge_core::json::parse(encoded).map_err(|_| ())?;
            let raw = match &value {
                Value::Null => None,
                Value::String(s) => Some(s.as_str()),
                _ => return Err(()),
            };
            copies::filter_issue(
                key,
                raw,
                &mut |candidate| candidate != target,
                0,
                copies::Mode::Scrub,
            )
            .map_err(|_| ())
        })();
        let value = match filtered {
            Ok(value) => value,
            Err(()) => {
                if !encoded.to_lowercase().contains(&target) {
                    continue;
                }
                None
            }
        };
        let next =
            value.map(|value| forge_core::canonical::javascript_stringify(&Value::String(value)));
        if next.as_ref() != Some(encoded) {
            sqlx::query("UPDATE product_state SET encoded_value=$2,revision=$3 WHERE id=$1")
                .bind(copy)
                .bind(next)
                .bind(revision + 1)
                .execute(&mut *tx)
                .await?;
        }
    }
    if rows.len() == 5 {
        sqlx::query("UPDATE issues SET purge_copy_cursor=$2,purge_lease_until=NULL,purge_token=NULL WHERE id=$1").bind(id).bind(rows[4].0).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(false);
    }
    let history:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM command_outbox_events WHERE workspace_id=$1 AND payload->>'issueId'=$2::uuid::text LIMIT 100").bind(workspace).bind(id).fetch_all(&mut *tx).await?;
    if !history.is_empty() {
        sqlx::query("DELETE FROM command_outbox_events WHERE id=ANY($1)")
            .bind(&history)
            .execute(&mut *tx)
            .await?;
    }
    if history.len() == 100 {
        release(&mut tx, id).await?;
        tx.commit().await?;
        return Ok(false);
    }
    sqlx::query("DELETE FROM documents WHERE issue_id=$1 AND NOT shared_with_workspace")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM issue_relations WHERE workspace_id=$1 AND (issue_id=$2 OR related_issue_id=$2)").bind(workspace).bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM issue_labels WHERE workspace_id=$1 AND issue_id=$2")
        .bind(workspace)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE issues SET parent_id=NULL WHERE workspace_id=$1 AND parent_id=$2")
        .bind(workspace)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE issues SET title='',properties='{}'::jsonb,parent_id=NULL,project_id=NULL,cycle_id=NULL,assignee_id=NULL,creator_id=NULL,purged_at=clock_timestamp(),purge_lease_until=NULL,purge_token=NULL,purge_error=NULL WHERE id=$1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(true)
}
async fn release(tx: &mut JournalTransaction, id: Uuid) -> Result<(), StoreError> {
    sqlx::query("UPDATE issues SET purge_lease_until=NULL,purge_token=NULL WHERE id=$1")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn loop_copies(
    db: &Database,
    blobs: &dyn Transport,
    id: Uuid,
    workspace: &str,
) -> Result<bool, StoreError> {
    const SOURCE: &str =
        "workspace_id=$1 AND event->>'entity'='issue' AND event->>'entityId'=$2::uuid::text";
    let raw=change(db,"DELETE FROM loop_events WHERE id IN (SELECT id FROM loop_events WHERE workspace_id=$1 AND entity='issue' AND entity_id=$2 ORDER BY id LIMIT 100)",workspace,id).await?;
    let dirty=change(db,&format!("UPDATE loop_runs SET state='cancelled',error_code='SOURCE_PURGED',result=NULL,pending_decision=NULL,event=jsonb_build_object('entity','issue','entityId',$2::uuid::text),finished_at=clock_timestamp(),lease_at=NULL WHERE id IN (SELECT id FROM loop_runs WHERE {SOURCE} AND (state<>'cancelled' OR error_code IS DISTINCT FROM 'SOURCE_PURGED' OR result IS NOT NULL OR pending_decision IS NOT NULL OR event<>jsonb_build_object('entity','issue','entityId',$2::uuid::text)) ORDER BY id LIMIT 25)"),workspace,id).await?;
    let owned = format!("SELECT agent_run_id FROM loop_runs WHERE {SOURCE}");
    let agents=change(db,&format!("UPDATE agent_runs SET state='cancelled',error_code='SOURCE_PURGED',completed_at=clock_timestamp() WHERE id IN (SELECT id FROM agent_runs WHERE id IN ({owned}) AND (state<>'cancelled' OR error_code IS DISTINCT FROM 'SOURCE_PURGED') ORDER BY id LIMIT 100)"),workspace,id).await?;
    let payloads=change(db,&format!("UPDATE agent_events SET payload_json='{{}}'::jsonb WHERE id IN (SELECT id FROM agent_events WHERE run_id IN ({owned}) AND payload_json<>'{{}}'::jsonb ORDER BY id LIMIT 100)"),workspace,id).await?;
    let approvals=change(db,&format!("UPDATE agent_approvals SET redacted_input_summary='{{}}'::jsonb,state=CASE WHEN state IN ('pending','approved') THEN 'expired' ELSE state END,resolved_at=CASE WHEN state IN ('pending','approved') THEN coalesce(resolved_at,clock_timestamp()) ELSE resolved_at END WHERE id IN (SELECT id FROM agent_approvals WHERE run_id IN ({owned}) AND (redacted_input_summary<>'{{}}'::jsonb OR state IN ('pending','approved')) ORDER BY id LIMIT 100)"),workspace,id).await?;
    let artifacts:Vec<(Uuid,String)>=sqlx::query_as(&format!("SELECT id,storage_reference FROM agent_artifacts WHERE run_id IN ({owned}) ORDER BY id LIMIT 100")).bind(workspace).bind(id).fetch_all(db.pool()).await?;
    for (artifact, reference) in &artifacts {
        blobs.delete(reference).await?;
        let mut tx = transaction(db).await?;
        sqlx::query(&format!(
            "DELETE FROM agent_artifacts WHERE id=$3 AND run_id IN ({owned})"
        ))
        .bind(workspace)
        .bind(id)
        .bind(artifact)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    }
    let reservations:Vec<(Uuid,String,bool)>=sqlx::query_as(&format!("SELECT id,storage_reference,created_at+interval '20 minutes'<=clock_timestamp() FROM loop_artifact_intents WHERE workspace_id=$1 AND loop_run_id IN (SELECT id FROM loop_runs WHERE {SOURCE}) ORDER BY created_at,id LIMIT 100")).bind(workspace).bind(id).fetch_all(db.pool()).await?;
    for (reservation, reference, ready) in &reservations {
        if !ready {
            continue;
        }
        blobs.delete(reference).await?;
        let mut tx = transaction(db).await?;
        sqlx::query("DELETE FROM loop_artifact_intents WHERE id=$1 AND storage_reference=$2")
            .bind(reservation)
            .bind(reference)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    Ok(raw == 100
        || dirty == 25
        || agents == 100
        || payloads == 100
        || approvals == 100
        || artifacts.len() == 100
        || reservations.len() == 100
        || reservations.iter().any(|r| !r.2))
}
async fn heartbeat(db: &Database, success: bool) -> Result<(), StoreError> {
    let mut tx = transaction(db).await?;
    sqlx::query("INSERT INTO operational_job_health(key,completed_at,failed_at) VALUES('issues.retention',CASE WHEN $1 THEN clock_timestamp() END,CASE WHEN NOT $1 THEN clock_timestamp() END) ON CONFLICT(key) DO UPDATE SET completed_at=CASE WHEN $1 THEN clock_timestamp() ELSE operational_job_health.completed_at END,failed_at=CASE WHEN NOT $1 THEN clock_timestamp() ELSE operational_job_health.failed_at END").bind(success).execute(&mut *tx).await?;
    tx.commit().await
}
pub async fn run(db: &Database, blobs: &dyn Transport) -> Result<Report, StoreError> {
    let result=async {
        let counts=purge(db,blobs,1).await?;
        let pending:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM issues WHERE deleted_at+interval '720 hours'<=clock_timestamp() AND purged_at IS NULL)").fetch_one(db.pool()).await?;
        heartbeat(db,counts.failed==0).await?;
        Ok(Report {purged:counts.purged,failed:counts.failed,pending})
    }.await;
    if result.is_err() {
        heartbeat(db, false).await?;
    }
    result
}
