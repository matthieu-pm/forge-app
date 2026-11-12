//! Shared call records use current team visibility. Transcript expiry is a
//! journaled redaction; summaries, decisions, notes and actions are retained.
use crate::{Database, StoreError, authority::current_actor, resource_policy as policy};
use chrono::{DateTime, SecondsFormat, Utc};
use forge_core::{
    actor::{Actor, ApiScope},
    calls as contract,
};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection};
use std::{collections::HashMap, sync::Arc};
use uuid::Uuid;
mod connections;
mod directory;
mod mutations;
mod summaries;
mod sync;
mod worker;
pub use worker::Report;
#[derive(Clone, Default)]
pub struct Options {
    pub environment: HashMap<String, String>,
}
impl Options {
    pub fn from_env() -> Self {
        Self {
            environment: std::env::vars().collect(),
        }
    }
}
#[derive(Clone)]
pub struct Service {
    pub database: Database,
    pub options: Options,
    pub now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    pub gateway: Option<Arc<dyn contract::providers::Gateway>>,
    pub vault: Option<Arc<dyn crate::agents::model_connections::Vault>>,
    pub summarizer: Option<Arc<dyn contract::providers::Summarizer>>,
}
impl Service {
    pub fn new(database: Database, options: Options) -> Self {
        Self {
            database,
            options,
            now: Arc::new(Utc::now),
            gateway: None,
            vault: None,
            summarizer: None,
        }
    }
    fn time(&self) -> DateTime<Utc> {
        DateTime::from_timestamp_millis((self.now)().timestamp_millis()).expect("valid clock")
    }
    pub async fn sweep(&self, workspace: Option<&str>) -> Result<u64, StoreError> {
        let workspaces: Vec<String> = sqlx::query_scalar("SELECT DISTINCT workspace_id FROM calls WHERE ($1::text IS NULL OR workspace_id=$1) ORDER BY workspace_id")
            .bind(workspace).fetch_all(self.database.pool()).await?;
        let now = self.time();
        let mut expired = 0;
        for workspace in workspaces {
            let mut tx = self.database.begin().await?;
            if sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
                .bind(&workspace)
                .fetch_optional(&mut *tx)
                .await?
                .is_some()
            {
                tx.prepare().await?;
                expired += sweep_in(&mut tx, &workspace, now).await?;
            }
            tx.commit().await?;
        }
        Ok(expired)
    }
}
fn input(kind: &str, value: Value) -> Result<Value, StoreError> {
    contract::input(kind, value).map_err(|_| StoreError::InvalidInput)
}
fn id(value: &Value) -> Result<Uuid, StoreError> {
    value
        .as_str()
        .ok_or(StoreError::InvalidInput)?
        .parse()
        .map_err(|_| StoreError::InvalidInput)
}
fn stamp(date: DateTime<Utc>) -> String {
    date.to_rfc3339_opts(SecondsFormat::Millis, true)
}
async fn scope(c: &mut PgConnection, actor: &Actor) -> Result<Actor, StoreError> {
    // Match workspace -> identity -> team -> call ordering across reads that
    // redact, imports, retention changes and concurrent workspace deletion.
    sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
        .bind(&actor.workspace_id)
        .fetch_optional(&mut *c)
        .await?
        .ok_or(StoreError::Forbidden)?;
    current_actor(c, actor).await
}
fn admin(actor: &Actor) -> Result<(), StoreError> {
    if policy::privileged(actor) {
        Ok(())
    } else {
        Err(StoreError::Forbidden)
    }
}
async fn retention(c: &mut PgConnection, workspace: &str) -> Result<i32, StoreError> {
    Ok(
        sqlx::query_scalar("SELECT retention_days FROM call_settings WHERE workspace_id=$1")
            .bind(workspace)
            .fetch_optional(c)
            .await?
            .unwrap_or(30),
    )
}
async fn sweep_in(
    c: &mut PgConnection,
    workspace: &str,
    now: DateTime<Utc>,
) -> Result<u64, StoreError> {
    let days = retention(c, workspace).await?;
    Ok(sqlx::query("UPDATE calls SET transcript='[]',status='expired',summary_lease_at=NULL WHERE workspace_id=$1 AND started_at<$2::timestamptz-($3::bigint*interval '1 day') AND status IN ('pending','ready','error')")
        .bind(workspace).bind(now).bind(i64::from(days)).execute(c).await?.rows_affected())
}
#[derive(FromRow)]
struct Call {
    id: Uuid,
    workspace_id: String,
    team_id: Uuid,
    provider: String,
    external_id: String,
    title: String,
    started_at: DateTime<Utc>,
    duration: i32,
    participants: Value,
    transcript: Value,
    summary: String,
    decisions: Value,
    status: String,
    summary_status: String,
    summary_lease_at: Option<DateTime<Utc>>,
}
impl Call {
    fn value(&self) -> Value {
        json!({"id":self.id,"workspaceId":self.workspace_id,"teamId":self.team_id,
            "provider":self.provider,"externalId":self.external_id,"title":self.title,
            "startedAt":stamp(self.started_at),"duration":self.duration,"participants":self.participants,
            "transcript":self.transcript,"summary":self.summary,"decisions":self.decisions,
            "status":self.status,"summaryStatus":self.summary_status,"summaryLeaseAt":self.summary_lease_at.map(stamp)})
    }
}
async fn require_call(c: &mut PgConnection, actor: &Actor, call: Uuid) -> Result<Call, StoreError> {
    policy::scope(actor, ApiScope::TeamsRead)?;
    // Stabilize the team first; a call's team/workspace are immutable in schema.
    let team: Uuid =
        sqlx::query_scalar("SELECT team_id FROM calls WHERE workspace_id=$1 AND id=$2")
            .bind(&actor.workspace_id)
            .bind(call)
            .fetch_optional(&mut *c)
            .await?
            .ok_or(StoreError::NotFound)?;
    policy::team(c, actor, team).await?;
    sqlx::query_as("SELECT * FROM calls WHERE workspace_id=$1 AND id=$2 FOR UPDATE")
        .bind(&actor.workspace_id)
        .bind(call)
        .fetch_optional(c)
        .await?
        .ok_or(StoreError::NotFound)
}
async fn decorate(c: &mut PgConnection, rows: &[Call]) -> Result<Vec<Value>, StoreError> {
    if rows.is_empty() {
        return Ok(vec![]);
    }
    let ids: Vec<_> = rows.iter().map(|r| r.id).collect();
    let actions: Vec<(Uuid, Value)> = sqlx::query_as("SELECT call_id,jsonb_build_object('id',id,'title',title,'owner',owner,'completed',completed) FROM call_actions WHERE call_id=ANY($1) ORDER BY id")
        .bind(&ids).fetch_all(&mut *c).await?;
    let notes: Vec<(Uuid, Uuid, String, String, String, DateTime<Utc>)> = sqlx::query_as("SELECT n.call_id,n.id,n.body,n.kind,u.name,n.created_at FROM call_notes n JOIN \"user\" u ON u.id=n.user_id WHERE n.call_id=ANY($1) ORDER BY n.created_at,n.id")
        .bind(&ids).fetch_all(&mut *c).await?;
    Ok(rows.iter().map(|row| {
        let mut value = row.value();
        value["actions"] = json!(actions.iter().filter(|(id, _)| *id == row.id).map(|(_, v)| v).collect::<Vec<_>>());
        value["notes"] = json!(notes.iter().filter(|(id, ..)| *id == row.id).map(|(_, id, body, kind, author, created)|
            json!({"id":id,"body":body,"kind":kind,"author":author,"createdAt":stamp(*created)})).collect::<Vec<_>>());
        value
    }).collect())
}
