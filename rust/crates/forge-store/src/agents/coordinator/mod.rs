//! Actor-bound conversation operations. Authorization and related state/event
//! changes share a transaction; external attachment I/O precedes fresh checks.
use super::{approval_service::Request, *};
use crate::{Database, StoreError, authority::current_actor, database::JournalTransaction};
use chrono::{DateTime, Datelike, NaiveTime, SecondsFormat, Utc};
use forge_core::{
    actor::{Actor, ApiScope, Authentication},
    agents::{contracts, models, policy},
    security::SecurityAction,
};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

mod hosted;
mod local;
mod selection;
pub use hosted::{Hosted, RunSession};
pub use local::PreparedLocal;
pub const CODEX_LOCAL_CONNECTION_ID: &str = "00000000-0000-4000-8000-000000000099";

#[derive(Clone)]
pub struct Service {
    pub database: Database,
    pub attachments: Option<Arc<files::Service>>,
    pub hosted: Option<Arc<Hosted>>,
    pub controls: Value,
    pub now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
}
impl Service {
    pub fn new(database: Database) -> Self {
        Self {
            database,
            attachments: None,
            hosted: None,
            controls: policy::controls(&Default::default()),
            now: Arc::new(Utc::now),
        }
    }
    fn time(&self) -> DateTime<Utc> {
        DateTime::from_timestamp_millis((self.now)().timestamp_millis()).unwrap()
    }
    async fn begin(
        &self,
        actor: &Actor,
        scope: ApiScope,
        write: bool,
    ) -> Result<(JournalTransaction, Actor), StoreError> {
        let mut tx = self.database.begin().await?;
        let found: Option<String> = sqlx::query_scalar(if write {
            "SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE"
        } else {
            "SELECT id FROM organization WHERE id=$1 FOR KEY SHARE"
        })
        .bind(&actor.workspace_id)
        .fetch_optional(&mut *tx)
        .await?;
        if found.is_none() {
            return Err(StoreError::Forbidden);
        }
        let actor = current_actor(&mut tx, actor).await?;
        if !actor.has_scope(scope) {
            return Err(StoreError::Forbidden);
        }
        Ok((tx, actor))
    }
    async fn invoke(&self, tx: &mut JournalTransaction, actor: &Actor) -> Result<(), StoreError> {
        if matches!(
            actor.authentication,
            Authentication::Agent { .. } | Authentication::Loop { .. }
        ) || !crate::security::settings(tx, &actor.workspace_id)
            .await?
            .allows(actor, SecurityAction::AgentsInvoke)
        {
            return Err(StoreError::Forbidden);
        }
        Ok(())
    }
    async fn owned_thread(
        &self,
        tx: &mut JournalTransaction,
        actor: &Actor,
        id: Uuid,
        write: bool,
    ) -> Result<Thread, StoreError> {
        sqlx::query(if write {
            "SELECT id FROM agent_threads WHERE id=$1 AND workspace_id=$2 FOR NO KEY UPDATE"
        } else {
            "SELECT id FROM agent_threads WHERE id=$1 AND workspace_id=$2 FOR SHARE"
        })
        .bind(id)
        .bind(&actor.workspace_id)
        .fetch_optional(&mut **tx)
        .await?;
        let thread = threads::get_in(tx, &actor.workspace_id, id)
            .await?
            .filter(|t| t.created_by_user_id == actor.user_id)
            .ok_or_else(thread_missing)?;
        let shared: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM loop_runs WHERE thread_id=$1 AND workspace_id=$2)",
        )
        .bind(id)
        .bind(&actor.workspace_id)
        .fetch_one(&mut **tx)
        .await?;
        if shared {
            return Err(StoreError::Forbidden);
        }
        if let Authentication::Agent { run_id, .. } = &actor.authentication {
            let run = runs::get_in(tx, &actor.workspace_id, parse_id(&json!(run_id))?)
                .await?
                .ok_or_else(run_missing)?;
            if run.thread_id != id {
                return Err(StoreError::Forbidden);
            }
        }
        Ok(thread)
    }
    async fn owned_run(
        &self,
        tx: &mut JournalTransaction,
        actor: &Actor,
        id: Uuid,
        write: bool,
    ) -> Result<(Thread, Run), StoreError> {
        let run = runs::get_in(tx, &actor.workspace_id, id)
            .await?
            .filter(|r| r.initiated_by_user_id == actor.user_id)
            .ok_or_else(run_missing)?;
        if run.requested_selection.get("loopRunId").is_some()
            || matches!(&actor.authentication,Authentication::Agent{run_id,..}if run_id!=&id.to_string())
        {
            return Err(StoreError::Forbidden);
        }
        let thread = self.owned_thread(tx, actor, run.thread_id, write).await?;
        sqlx::query(if write {
            "SELECT id FROM agent_runs WHERE id=$1 FOR NO KEY UPDATE"
        } else {
            "SELECT id FROM agent_runs WHERE id=$1 FOR SHARE"
        })
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
        let run = runs::get_in(tx, &actor.workspace_id, id)
            .await?
            .ok_or_else(run_missing)?;
        Ok((thread, run))
    }
    pub async fn create_thread(&self, actor: &Actor, input: Value) -> Result<Thread, StoreError> {
        let (mut tx, actor) = self.begin(actor, ApiScope::AgentsWrite, true).await?;
        self.invoke(&mut tx, &actor).await?;
        let input = contracts::create_thread(input).map_err(|_| StoreError::InvalidInput)?;
        let thread = threads::create_in(
            &mut tx,
            &CreateThread {
                id: Uuid::new_v4(),
                workspace_id: actor.workspace_id,
                created_by_user_id: actor.user_id,
                title: input["title"].as_str().unwrap_or("New chat").into(),
                status: ThreadStatus::Active,
                runtime_kind: decode(input["runtimeKind"].clone())?,
                runtime_session_id: None,
                created_at: self.time(),
            },
        )
        .await?;
        tx.commit().await?;
        Ok(thread)
    }
    pub async fn list_threads(&self, actor: &Actor) -> Result<Vec<Thread>, StoreError> {
        let (mut tx, actor) = self.begin(actor, ApiScope::AgentsRead, false).await?;
        let result = threads::list_in(&mut tx, &actor.workspace_id, &actor.user_id).await?;
        tx.commit().await?;
        Ok(result)
    }
    pub async fn mutate_thread(
        &self,
        actor: &Actor,
        id: Uuid,
        input: Value,
    ) -> Result<Thread, StoreError> {
        let (mut tx, actor) = self.begin(actor, ApiScope::AgentsWrite, true).await?;
        self.owned_thread(&mut tx, &actor, id, true).await?;
        let action = input["action"].as_str().ok_or(StoreError::InvalidInput)?;
        let kind = match action {
            "rename" => "thread.rename",
            "archive" => "thread.archive",
            "reopen" => "thread.reopen",
            _ => return Err(StoreError::InvalidInput),
        };
        let mut body = input.clone();
        body.as_object_mut()
            .ok_or(StoreError::InvalidInput)?
            .remove("action");
        body["threadId"] = json!(id);
        let input = contracts::command(json!({"type":kind,"input":body}))
            .map_err(|_| StoreError::InvalidInput)?;
        let patch = ThreadPatch {
            title: input["input"]["title"].as_str().map(str::to_owned),
            status: match action {
                "archive" => Some(ThreadStatus::Archived),
                "reopen" => Some(ThreadStatus::Active),
                _ => None,
            },
            last_activity_at: Some(self.time()),
            ..Default::default()
        };
        let thread = threads::update_in(&mut tx, &actor.workspace_id, id, &patch)
            .await?
            .ok_or_else(thread_missing)?;
        tx.commit().await?;
        Ok(thread)
    }
    pub async fn thread_events(&self, actor: &Actor, id: Uuid) -> Result<Vec<Event>, StoreError> {
        let (mut tx, actor) = self.begin(actor, ApiScope::AgentsRead, false).await?;
        self.owned_thread(&mut tx, &actor, id, false).await?;
        let result = events::list_thread_in(&mut tx, id, 0).await?;
        tx.commit().await?;
        Ok(result)
    }
    pub async fn run_events(
        &self,
        actor: &Actor,
        id: Uuid,
        after: i32,
    ) -> Result<Vec<Event>, StoreError> {
        let (mut tx, actor) = self.begin(actor, ApiScope::AgentsRead, false).await?;
        self.owned_run(&mut tx, &actor, id, false).await?;
        let result = events::list_run_in(&mut tx, id, after).await?;
        tx.commit().await?;
        Ok(result)
    }
    async fn budget(&self, tx: &mut JournalTransaction, actor: &Actor) -> Result<(), StoreError> {
        let since = self
            .time()
            .with_day(1)
            .unwrap()
            .date_naive()
            .and_time(NaiveTime::MIN)
            .and_utc();
        let user =
            runs::usage_in(tx, &actor.workspace_id, Some(&actor.user_id), since, None).await?;
        let workspace = runs::usage_in(tx, &actor.workspace_id, None, since, None).await?;
        if let Some(message) = policy::budget(
            &self.controls,
            user.cost_micros as f64,
            workspace.cost_micros as f64,
        ) {
            return Err(error("BUDGET_EXCEEDED", message));
        }
        Ok(())
    }
    async fn resolve_attachments(
        &self,
        actor: &Actor,
        ids: &[Uuid],
    ) -> Result<Vec<Value>, StoreError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        self.attachments
            .as_ref()
            .ok_or_else(|| {
                error(
                    "RUNTIME_UNAVAILABLE",
                    "Attachments are unavailable for this deployment.",
                )
            })?
            .resolve_attachments(actor, ids)
            .await
    }
    async fn request_approval(
        &self,
        tx: &mut JournalTransaction,
        actor: &Actor,
        run: Uuid,
        payload: Value,
    ) -> Result<(Event, bool), StoreError> {
        let request =
            contracts::runtime_approval(payload, true).map_err(|_| StoreError::InvalidInput)?;
        let id = parse_id(&request["approvalId"])?;
        let input = request
            .get("input")
            .cloned()
            .unwrap_or_else(|| json!({"summary":request["summary"],"details":request["details"]}));
        if let Some(existing) = approvals::get(tx, id).await? {
            if existing.workspace_id != actor.workspace_id
                || existing.requested_for_user_id != actor.user_id
                || existing.run_id != run
                || existing.capability_id != request["capabilityId"]
                || existing.capability_version != request["capabilityVersion"]
                || existing.input_hash != forge_core::agents::approval::input_hash(&input)
            {
                return Err(StoreError::Conflict);
            }
            let event = events::existing(tx, run, &format!("approval:{id}:requested"))
                .await?
                .ok_or(StoreError::Conflict)?;
            return Ok((event, false));
        }
        let resolution=approval_service::Service::new(self.database.clone()).with_clock(self.now.clone()).request_in(tx,actor,&Request{approval_id:Some(id),run_id:run,capability_id:request["capabilityId"].as_str().unwrap().into(),capability_version:request["capabilityVersion"].as_str().unwrap().into(),risk:decode(request["risk"].clone())?,input,redacted_input_summary:json!({"summary":request["summary"],"details":request["details"]}),expires_at:Some(decode(request["expiresAt"].clone())?)}).await?;
        Ok((resolution.event, true))
    }
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, StoreError> {
    serde_json::from_value(value).map_err(|_| StoreError::InvalidInput)
}
fn parse_id(value: &Value) -> Result<Uuid, StoreError> {
    value
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or(StoreError::InvalidInput)
}
fn error(code: &'static str, message: &'static str) -> StoreError {
    StoreError::AgentCoordinator { code, message }
}
fn thread_missing() -> StoreError {
    error("THREAD_NOT_FOUND", "The agent thread was not found.")
}
fn run_missing() -> StoreError {
    error("RUN_NOT_FOUND", "The agent run was not found.")
}
fn iso(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn terminal(state: RunState) -> bool {
    matches!(
        state,
        RunState::Completed | RunState::Cancelled | RunState::Failed
    )
}
fn local(run: &Run) -> Result<(), StoreError> {
    if run.execution_kind != Execution::ExternalAgent {
        return Err(run_missing());
    }
    Ok(())
}
