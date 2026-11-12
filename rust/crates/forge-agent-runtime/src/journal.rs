//! Explicitly installed private PostgreSQL runtime storage. Authentication is
//! supplied by a freshly verified channel. Forge's model/capability endpoints
//! independently recheck live application authority before external effects.
use crate::{
    Error, Result,
    auth::Channel,
    engine::{Decision, Journal, Phase, State},
};
use async_trait::async_trait;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use forge_core::canonical::javascript_stringify;
use futures_util::TryStreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool};
use std::time::Duration;
use uuid::Uuid;

mod conversation;
mod response;
pub use response::{InputReceipt, ResponseProof};
const SCHEMAS: &[&str] = &[
    include_str!("../migrations/0001_runtime.sql"),
    include_str!("../migrations/0002_conversations.sql"),
    include_str!("../migrations/0003_compaction_recovery.sql"),
    include_str!("../migrations/0004_session_budgets.sql"),
    include_str!("../migrations/0005_input_continuations.sql"),
    include_str!("../migrations/0006_input_delivery_owners.sql"),
];
fn versions() -> Vec<(i32, String)> {
    SCHEMAS
        .iter()
        .enumerate()
        .map(|(i, s)| {
            (
                (i + 1) as i32,
                format!("{:x}", Sha256::digest(s.as_bytes())),
            )
        })
        .collect()
}
const FAILED: Error = Error("The runtime journal is unavailable.");
/// A failed commit acknowledgement or post-commit read is not a rejected
/// admission. Callers must retry the exact request without rolling back intent.
pub fn outcome_unknown(error: &Error) -> bool {
    *error == FAILED
}
const INVALID: Error = Error("The runtime session is unavailable or outside this run's scope.");
const BUSY: Error = Error("Another worker owns the runtime session.");
const LOST: Error = Error("The runtime worker lease has expired or been superseded.");
const LIMIT: usize = 8 * 1024 * 1024;
const JOURNAL_LIMIT: i64 = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct Store {
    pool: PgPool,
}
pub struct Session {
    pub state: State,
    pub next_index: u64,
    pub deadline: DateTime<Utc>,
    pub cancelled: bool,
    pub worker_active: bool,
    pub continued_by: Option<Uuid>,
    pub delivery_only: bool,
    pub input_generation: u64,
    pub conversation: Option<ConversationProof>,
    pub pending_requests: Vec<Value>,
}
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationProof {
    pub id: Uuid,
    pub head_run_id: Uuid,
    pub generation: u64,
    pub owner_run_id: Uuid,
    pub owner_next_index: u64,
    pub owner_deadline: i64,
}
pub struct Event {
    pub index: u64,
    pub value: Value,
}
pub struct Lease {
    store: Store,
    channel: Channel,
    owner: Uuid,
    epoch: i64,
    ttl_ms: i64,
}
#[derive(sqlx::FromRow)]
struct Row {
    run_id: Uuid,
    workspace_id: String,
    user_id: String,
    conversation_id: Option<Uuid>,
    parent_run_id: Option<Uuid>,
    initial_hash: String,
    revision: i64,
    snapshot: String,
    next_index: i64,
    journal_bytes: i64,
    epoch: i64,
    lease_owner: Option<Uuid>,
    lease_until: Option<DateTime<Utc>>,
    deadline: DateTime<Utc>,
    cancelled_at: Option<DateTime<Utc>>,
    continued_by_run_id: Option<Uuid>,
    delivery_only: bool,
    input_generation: i64,
    worker_active: bool,
}
const COLUMNS: &str = "run_id,workspace_id,user_id,conversation_id,parent_run_id,initial_hash,revision,engine_state::text AS snapshot,next_index,journal_bytes,epoch,lease_owner,lease_until,deadline,cancelled_at,continued_by_run_id,delivery_only,input_generation,COALESCE(lease_until > clock_timestamp() AND deadline > clock_timestamp() AND cancelled_at IS NULL AND continued_by_run_id IS NULL AND NOT delivery_only,false) AS worker_active";

#[derive(sqlx::FromRow)]
struct ContextRow {
    #[sqlx(flatten)]
    row: Row,
    head_run_id: Option<Uuid>,
    execution_run_id: Option<Uuid>,
    conversation_generation: Option<i64>,
    owner_snapshot: Option<String>,
    owner_next_index: Option<i64>,
    owner_deadline: Option<DateTime<Utc>>,
    owner_cancelled: Option<bool>,
}
fn run(channel: &Channel) -> Result<Uuid> {
    channel.run_id().parse().map_err(|_| INVALID)
}
fn scoped(row: &Row, channel: &Channel) -> Result<()> {
    if row.workspace_id != channel.workspace_id() || row.user_id != channel.principal_id() {
        return Err(INVALID);
    }
    Ok(())
}
fn restored(row: &Row, channel: &Channel) -> Result<State> {
    scoped(row, channel)?;
    State::restore(
        forge_core::json::parse(&row.snapshot).map_err(|_| FAILED)?,
        channel,
    )
    .map_err(|_| INVALID)
}
async fn locked(connection: &mut PgConnection, channel: &Channel) -> Result<Row> {
    let row = sqlx::query_as::<_, Row>(&format!(
        "SELECT {COLUMNS} FROM forge_runtime.sessions WHERE run_id=$1 FOR UPDATE"
    ))
    .bind(run(channel)?)
    .fetch_optional(connection)
    .await
    .map_err(|_| FAILED)?
    .ok_or(INVALID)?;
    scoped(&row, channel)?;
    Ok(row)
}
async fn now(connection: &mut PgConnection) -> Result<DateTime<Utc>> {
    sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(connection)
        .await
        .map_err(|_| FAILED)
}
fn until(now: DateTime<Utc>, deadline: DateTime<Utc>, ttl_ms: i64) -> DateTime<Utc> {
    (now + ChronoDuration::milliseconds(ttl_ms)).min(deadline)
}
impl Store {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
    /// Operator/test setup only. Neither `new` nor any request operation runs DDL.
    pub async fn install(pool: &PgPool) -> Result<()> {
        let mut tx = pool.begin().await.map_err(|_| FAILED)?;
        sqlx::query("SELECT pg_advisory_xact_lock(2026111101)")
            .execute(&mut *tx)
            .await
            .map_err(|_| FAILED)?;
        sqlx::raw_sql("CREATE SCHEMA IF NOT EXISTS forge_runtime; CREATE TABLE IF NOT EXISTS forge_runtime.migrations (version integer PRIMARY KEY, digest text NOT NULL)").execute(&mut *tx).await.map_err(|_|FAILED)?;
        let installed: Vec<(i32, String)> =
            sqlx::query_as("SELECT version,digest FROM forge_runtime.migrations ORDER BY version")
                .fetch_all(&mut *tx)
                .await
                .map_err(|_| FAILED)?;
        let expected = versions();
        if installed.len() > expected.len() || installed != expected[..installed.len()] {
            return Err(Error(
                "The runtime journal schema does not match this build.",
            ));
        }
        for (version, digest) in expected.iter().skip(installed.len()) {
            sqlx::raw_sql(SCHEMAS[*version as usize - 1])
                .execute(&mut *tx)
                .await
                .map_err(|_| FAILED)?;
            sqlx::query("INSERT INTO forge_runtime.migrations(version,digest) VALUES($1,$2)")
                .bind(version)
                .bind(digest)
                .execute(&mut *tx)
                .await
                .map_err(|_| FAILED)?;
        }
        tx.commit().await.map_err(|_| FAILED)
    }
    pub async fn verify(pool: &PgPool) -> Result<()> {
        let installed: Vec<(i32, String)> =
            sqlx::query_as("SELECT version,digest FROM forge_runtime.migrations ORDER BY version")
                .fetch_all(pool)
                .await
                .map_err(|_| FAILED)?;
        if installed != versions() {
            return Err(Error(
                "The runtime journal schema does not match this build.",
            ));
        }
        Ok(())
    }
    pub async fn create(
        &self,
        channel: &Channel,
        state: &State,
        deadline: DateTime<Utc>,
    ) -> Result<Session> {
        state.validate(channel)?;
        if state.phase() != Phase::Ready || state.revision() != 0 {
            return Err(INVALID);
        }
        let deadline =
            DateTime::from_timestamp_millis(deadline.timestamp_millis()).ok_or(INVALID)?;
        let snapshot = state.snapshot();
        if snapshot["step"] != 0
            || snapshot["next_call"] != 0
            || snapshot["input_tokens"] != 0
            || snapshot["output_tokens"] != 0
            || snapshot["calls"] != json!([])
            || snapshot["decisions"] != json!({})
            || snapshot["questions"] != json!([])
            || snapshot["question_answers"] != json!({})
            || !snapshot["question_followup"].is_null()
            || snapshot["pending_input"]
                != serde_json::to_value(forge_core::agents::pending_input::PendingState::default())
                    .map_err(|_| INVALID)?
            || snapshot["issued_requests"] != json!({})
            || snapshot["todos"] != json!([])
            || snapshot["budget"]
                != json!({"prior":{"input":0,"output":0},"granted":null,"pending":null})
            || snapshot["compaction"]
                != json!({"last_input_tokens":null,"last_prompt_messages":null,"active":null})
            || snapshot["workspace"]["provisioned"] == true
            || !snapshot["files"]["workspace"].is_null()
            || snapshot["files"]["stamps"] != json!({})
        {
            return Err(INVALID);
        }
        let text = javascript_stringify(&snapshot);
        if text.len() > LIMIT {
            return Err(INVALID);
        }
        // Instructions may legitimately change during a deployment. Idempotent
        // admission binds the run, model selection and actual conversation input.
        let digest_input = json!({"binding":snapshot["binding"],"messages":state.history().iter().skip(1).collect::<Vec<_>>()});
        let hash = format!(
            "{:x}",
            Sha256::digest(javascript_stringify(&digest_input).as_bytes())
        );
        let mut tx = self.pool.begin().await.map_err(|_| FAILED)?;
        sqlx::query("INSERT INTO forge_runtime.sessions(run_id,workspace_id,user_id,initial_hash,engine_state,deadline) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(run_id) DO NOTHING").bind(run(channel)?).bind(channel.workspace_id()).bind(channel.principal_id()).bind(&hash).bind(text).bind(deadline).execute(&mut *tx).await.map_err(|_|FAILED)?;
        let row = locked(&mut tx, channel).await?;
        if row.initial_hash != hash || row.deadline != deadline || row.conversation_id.is_some() {
            return Err(Error("The run already has a different runtime admission."));
        }
        restored(&row, channel)?;
        tx.commit().await.map_err(|_| FAILED)?;
        self.load(channel).await.map_err(|_| FAILED)
    }
    pub async fn load(&self, channel: &Channel) -> Result<Session> {
        // Read delivery and current owner in one MVCC snapshot: separate reads
        // can combine an old delivery proof with a newly rebound owner's batch.
        let context = sqlx::query_as::<_, ContextRow>(&format!(
            "SELECT requested.*,c.last_run_id AS head_run_id,c.execution_run_id,c.generation AS conversation_generation,owner.engine_state::text AS owner_snapshot,owner.next_index AS owner_next_index,owner.deadline AS owner_deadline,(owner.cancelled_at IS NOT NULL) AS owner_cancelled FROM (SELECT {COLUMNS} FROM forge_runtime.sessions WHERE run_id=$1) requested LEFT JOIN forge_runtime.conversations c ON c.id=requested.conversation_id LEFT JOIN forge_runtime.sessions owner ON owner.run_id=c.execution_run_id AND owner.conversation_id=c.id AND owner.workspace_id=requested.workspace_id AND owner.user_id=requested.user_id"
        ))
        .bind(run(channel)?)
        .fetch_optional(&self.pool)
        .await
        .map_err(|_| FAILED)?
        .ok_or(INVALID)?;
        let row = context.row;
        let state = restored(&row, channel)?;
        let (conversation, pending_requests) = if let Some(id) = row.conversation_id {
            let owner_id = context.execution_run_id.ok_or(INVALID)?;
            let owner = State::restore_parent(
                forge_core::json::parse(context.owner_snapshot.as_deref().ok_or(INVALID)?)
                    .map_err(|_| FAILED)?,
                channel,
                &owner_id.to_string(),
            )?;
            let pending = if context.owner_cancelled == Some(true) {
                vec![]
            } else {
                owner.pending_requests()
            };
            (
                Some(ConversationProof {
                    id,
                    head_run_id: context.head_run_id.ok_or(INVALID)?,
                    generation: context.conversation_generation.ok_or(INVALID)? as u64,
                    owner_run_id: owner_id,
                    owner_next_index: context.owner_next_index.ok_or(INVALID)? as u64,
                    owner_deadline: context.owner_deadline.ok_or(INVALID)?.timestamp_millis(),
                }),
                pending,
            )
        } else {
            (
                None,
                if row.cancelled_at.is_some() {
                    vec![]
                } else {
                    state.pending_requests()
                },
            )
        };
        Ok(Session {
            state,
            next_index: row.next_index as u64,
            deadline: row.deadline,
            cancelled: row.cancelled_at.is_some(),
            worker_active: row.worker_active,
            continued_by: row.continued_by_run_id,
            delivery_only: row.delivery_only,
            input_generation: row.input_generation as u64,
            conversation,
            pending_requests,
        })
    }
    /// Persist a resolved approval before acknowledging delivery. Only a parked
    /// run may transition; the epoch change fences its old worker's return.
    pub async fn respond(
        &self,
        channel: &Channel,
        request: &str,
        decision: Decision,
    ) -> Result<bool> {
        Ok(!self
            .respond_at(channel, request, decision, None)
            .await?
            .replayed)
    }
    pub async fn acquire(
        &self,
        channel: &Channel,
        owner: Uuid,
        ttl: Duration,
    ) -> Result<(Lease, State)> {
        let ttl_ms = i64::try_from(ttl.as_millis())
            .ok()
            .filter(|v| (1000..=60000).contains(v))
            .ok_or(INVALID)?;
        let mut tx = self.pool.begin().await.map_err(|_| FAILED)?;
        let row = locked(&mut tx, channel).await?;
        let now = now(&mut tx).await?;
        let state = restored(&row, channel)?;
        if row.cancelled_at.is_some()
            || row.continued_by_run_id.is_some()
            || row.delivery_only
            || row.deadline <= now
        {
            return Err(LOST);
        }
        // A parked worker has committed that it will perform no more effects.
        // An approval handler can take ownership immediately and fence its return.
        if row.lease_until.is_some_and(|v| v > now)
            && row.lease_owner != Some(owner)
            && state.phase() != Phase::Waiting
        {
            return Err(BUSY);
        }
        let epoch = row.epoch.checked_add(1).ok_or(LOST)?;
        sqlx::query("UPDATE forge_runtime.sessions SET lease_owner=$2,lease_until=$3,epoch=$4,updated_at=$5 WHERE run_id=$1").bind(run(channel)?).bind(owner).bind(until(now,row.deadline,ttl_ms)).bind(epoch).bind(now).execute(&mut *tx).await.map_err(|_|FAILED)?;
        let lease = Lease {
            store: self.clone(),
            channel: channel.clone(),
            owner,
            epoch,
            ttl_ms,
        };
        lease.check(&mut tx).await?;
        tx.commit().await.map_err(|_| FAILED)?;
        Ok((lease, state))
    }
    pub async fn events(&self, channel: &Channel, after: u64, limit: usize) -> Result<Vec<Event>> {
        let after = i64::try_from(after).map_err(|_| INVALID)?;
        if limit == 0 || limit > 64 {
            return Err(INVALID);
        }
        // An owner-scoped join also protects the read if the session is removed
        // between this request and stream consumption. Owners are immutable.
        let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM forge_runtime.sessions WHERE run_id=$1 AND workspace_id=$2 AND user_id=$3)").bind(run(channel)?).bind(channel.workspace_id()).bind(channel.principal_id()).fetch_one(&self.pool).await.map_err(|_|FAILED)?;
        if !exists {
            return Err(INVALID);
        }
        let mut rows=sqlx::query_as::<_,(i64,String)>("SELECT e.stream_index,e.event::text FROM forge_runtime.events e JOIN forge_runtime.sessions s USING(run_id) WHERE e.run_id=$1 AND s.workspace_id=$2 AND s.user_id=$3 AND e.stream_index>=$4 ORDER BY e.stream_index LIMIT $5").bind(run(channel)?).bind(channel.workspace_id()).bind(channel.principal_id()).bind(after).bind(limit as i64).fetch(&self.pool);
        let mut result = vec![];
        let mut bytes = 0;
        while let Some((index, text)) = rows.try_next().await.map_err(|_| FAILED)? {
            if !result.is_empty() && bytes + text.len() > LIMIT {
                break;
            }
            if text.len() > 2 * LIMIT {
                return Err(FAILED);
            }
            bytes += text.len();
            let value = forge_core::json::parse(&text).map_err(|_| FAILED)?;
            result.push(Event {
                index: index as u64,
                value,
            });
        }
        Ok(result)
    }
    /// Cancellation accepts a run-scoped cancellation channel even when it has
    /// placeholder model attributes. It cannot read or change another owner's run.
    pub async fn cancel(&self, channel: &Channel) -> Result<bool> {
        let mut tx = self.pool.begin().await.map_err(|_| FAILED)?;
        let row = locked(&mut tx, channel).await?;
        if row.cancelled_at.is_some() || row.continued_by_run_id.is_some() {
            tx.commit().await.map_err(|_| FAILED)?;
            return Ok(false);
        }
        let at = now(&mut tx).await?;
        let epoch = row.epoch.checked_add(1).ok_or(LOST)?;
        append(
            &mut tx,
            channel,
            &row,
            &[
                json!({"type":"turn.cancelled","data":{"turnId":channel.run_id()}}),
                json!({"type":"session.waiting","data":{}}),
            ],
            at,
            true,
        )
        .await?;
        sqlx::query("UPDATE forge_runtime.sessions SET cancelled_at=$2,lease_owner=NULL,lease_until=NULL,epoch=$3,updated_at=$2 WHERE run_id=$1").bind(run(channel)?).bind(at).bind(epoch).execute(&mut *tx).await.map_err(|_|FAILED)?;
        tx.commit().await.map_err(|_| FAILED)?;
        Ok(true)
    }
}
async fn append(
    connection: &mut PgConnection,
    channel: &Channel,
    row: &Row,
    events: &[Value],
    at: DateTime<Utc>,
    cancellation: bool,
) -> Result<()> {
    if events.len() > 256 {
        return Err(INVALID);
    }
    let capacity = if cancellation {
        JOURNAL_LIMIT
    } else {
        JOURNAL_LIMIT - 4096
    };
    let mut bytes = row.journal_bytes;
    let mut index = row.next_index;
    for event in events {
        forge_core::agents::eve::basic(event).map_err(|_| INVALID)?;
        let mut event = event.clone();
        let id = Uuid::new_v4();
        event["_meta"] =
            json!({"id":id,"at":at.to_rfc3339_opts(chrono::SecondsFormat::Millis,true)});
        let text = javascript_stringify(&event);
        if text.len() > LIMIT {
            return Err(Error("The runtime event exceeds its size limit."));
        }
        bytes = bytes
            .checked_add(text.len() as i64)
            .filter(|n| *n <= capacity)
            .ok_or(Error("The runtime event journal exceeds its size limit."))?;
        sqlx::query("INSERT INTO forge_runtime.events(run_id,stream_index,event_id,event,created_at) VALUES($1,$2,$3,$4::jsonb,$5)").bind(run(channel)?).bind(index).bind(id).bind(text).bind(at).execute(&mut *connection).await.map_err(|_|FAILED)?;
        index = index.checked_add(1).ok_or(INVALID)?;
    }
    sqlx::query("UPDATE forge_runtime.sessions SET next_index=$2,journal_bytes=$3,updated_at=$4 WHERE run_id=$1").bind(run(channel)?).bind(index).bind(bytes).bind(at).execute(connection).await.map_err(|_|FAILED)?;
    Ok(())
}
impl Lease {
    async fn check(&self, connection: &mut PgConnection) -> Result<(Row, DateTime<Utc>)> {
        let row = locked(connection, &self.channel).await?;
        let at = now(connection).await?;
        if row.lease_owner != Some(self.owner)
            || row.epoch != self.epoch
            || row.lease_until.is_none_or(|until| until <= at)
            || row.deadline <= at
            || row.cancelled_at.is_some()
            || row.continued_by_run_id.is_some()
            || row.delivery_only
        {
            return Err(LOST);
        }
        Ok((row, at))
    }
    pub async fn renew(&self) -> Result<()> {
        let mut tx = self.store.pool.begin().await.map_err(|_| FAILED)?;
        let (row, at) = self.check(&mut tx).await?;
        sqlx::query(
            "UPDATE forge_runtime.sessions SET lease_until=$2,updated_at=$3 WHERE run_id=$1",
        )
        .bind(run(&self.channel)?)
        .bind(until(at, row.deadline, self.ttl_ms))
        .bind(at)
        .execute(&mut *tx)
        .await
        .map_err(|_| FAILED)?;
        self.check(&mut tx).await?;
        tx.commit().await.map_err(|_| FAILED)
    }
    pub async fn release(&self) -> Result<bool> {
        let result=sqlx::query("UPDATE forge_runtime.sessions SET lease_owner=NULL,lease_until=NULL WHERE run_id=$1 AND workspace_id=$2 AND user_id=$3 AND lease_owner=$4 AND epoch=$5").bind(run(&self.channel)?).bind(self.channel.workspace_id()).bind(self.channel.principal_id()).bind(self.owner).bind(self.epoch).execute(&self.store.pool).await.map_err(|_|FAILED)?;
        Ok(result.rows_affected() == 1)
    }
}
#[async_trait]
impl Journal for Lease {
    async fn commit(&self, expected: u64, next: &State, events: &[Value]) -> Result<()> {
        next.validate(&self.channel)?;
        if next.revision() != expected.checked_add(1).ok_or(INVALID)? {
            return Err(INVALID);
        }
        let text = javascript_stringify(&next.snapshot());
        if text.len() > LIMIT {
            return Err(INVALID);
        }
        let expected = i64::try_from(expected).map_err(|_| INVALID)?;
        let mut tx = self.store.pool.begin().await.map_err(|_| FAILED)?;
        let (row, at) = self.check(&mut tx).await?;
        if row.revision != expected {
            return Err(Error("The runtime continuation has a newer revision."));
        }
        sqlx::query("UPDATE forge_runtime.sessions SET revision=$2,engine_state=$3::jsonb,lease_until=$4 WHERE run_id=$1").bind(run(&self.channel)?).bind(next.revision() as i64).bind(text).bind(until(at,row.deadline,self.ttl_ms)).execute(&mut *tx).await.map_err(|_|FAILED)?;
        append(&mut tx, &self.channel, &row, events, at, false).await?;
        self.check(&mut tx).await?;
        tx.commit().await.map_err(|_| FAILED)
    }
    async fn append(&self, revision: u64, event: Value) -> Result<()> {
        let revision = i64::try_from(revision).map_err(|_| INVALID)?;
        let mut tx = self.store.pool.begin().await.map_err(|_| FAILED)?;
        let (row, at) = self.check(&mut tx).await?;
        if row.revision != revision {
            return Err(Error("The runtime continuation has a newer revision."));
        }
        append(&mut tx, &self.channel, &row, &[event], at, false).await?;
        self.check(&mut tx).await?;
        tx.commit().await.map_err(|_| FAILED)
    }
}
