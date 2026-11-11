//! Persistent job leases and checkpoints. Every write uses the same independent
//! deletion-journal preparation as application commands, including callback SQL.
pub mod cli;
pub mod invitations;
mod recovery;
pub mod retention;
pub mod runner;
use crate::{Database, database::JournalTransaction};
pub use forge_core::jobs::*;
use futures_util::future::BoxFuture;
use serde_json::Value;
use sqlx::{PgConnection, Row};
use uuid::Uuid;

#[derive(Clone)]
pub struct JobStore {
    database: Database,
}
pub(super) fn failed<E>(_: E) -> Error {
    Code::JobFailed.into()
}
fn state(value: &str) -> Result<State> {
    serde_json::from_value(Value::String(value.into())).map_err(failed)
}
impl JobStore {
    pub fn new(database: Database) -> Self {
        Self { database }
    }
    pub(crate) fn database(&self) -> &Database {
        &self.database
    }
    async fn transaction(&self) -> Result<JournalTransaction> {
        let mut tx = self.database.begin().await.map_err(failed)?;
        for statement in [
            "SET LOCAL statement_timeout='30s'",
            "SET LOCAL lock_timeout='5s'",
            "SET LOCAL idle_in_transaction_session_timeout='30s'",
        ] {
            sqlx::query(statement)
                .execute(&mut *tx)
                .await
                .map_err(failed)?;
        }
        tx.prepare().await.map_err(failed)?;
        Ok(tx)
    }
    async fn fence(tx: &mut PgConnection, lease: &Lease, lock: bool) -> Result<()> {
        let query = if lock {
            "SELECT id FROM background_jobs WHERE id=$1 AND lease_token=$2 AND generation=$3 AND state='running' AND lease_until>clock_timestamp() FOR UPDATE"
        } else {
            "SELECT id FROM background_jobs WHERE id=$1 AND lease_token=$2 AND generation=$3 AND state='running' AND lease_until>clock_timestamp()"
        };
        let owned: Option<Uuid> = sqlx::query_scalar(query)
            .bind(lease.id)
            .bind(lease.token)
            .bind(lease.generation)
            .fetch_optional(tx)
            .await
            .map_err(failed)?;
        owned.ok_or(Code::LeaseLost)?;
        Ok(())
    }
    pub async fn enqueue(&self, input: &Enqueue) -> Result<Uuid> {
        input.validate()?;
        let mut tx = self.transaction().await?;
        let id = Self::enqueue_in(&mut tx, input).await?;
        tx.commit().await.map_err(failed)?;
        Ok(id)
    }
    // The caller prepares the recovery journal before entering this helper.
    async fn enqueue_in(tx: &mut PgConnection, input: &Enqueue) -> Result<Uuid> {
        let (body, hash) = input.validate()?;
        // JavaScript Date persists millisecond precision, including its identity.
        let scheduled =
            chrono::DateTime::from_timestamp_millis(input.scheduled_at.timestamp_millis())
                .ok_or(Code::InvalidInput)?;
        sqlx::query("INSERT INTO background_jobs(kind,scope,identity,input_hash,input,scheduled_at,available_at,max_attempts) VALUES($1,$2,$3,$4,$5::jsonb,$6,$6,$7) ON CONFLICT(kind,scope,identity) DO NOTHING")
            .bind(&input.kind).bind(&input.scope).bind(&input.identity).bind(&hash).bind(body).bind(scheduled).bind(input.max_attempts).execute(&mut *tx).await.map_err(failed)?;
        let row: (Uuid, String) = sqlx::query_as(
            "SELECT id,input_hash FROM background_jobs WHERE kind=$1 AND scope=$2 AND identity=$3",
        )
        .bind(&input.kind)
        .bind(&input.scope)
        .bind(&input.identity)
        .fetch_one(&mut *tx)
        .await
        .map_err(failed)?;
        if row.1 != hash {
            return Err(Code::IdentityConflict.into());
        }
        Ok(row.0)
    }
    pub async fn reap(&self, kind: Option<&str>, id: Option<Uuid>) -> Result<Vec<Value>> {
        if kind.is_some_and(|v| !v.is_empty() && !key(v)) {
            return Err(Code::InvalidInput.into());
        }
        let mut tx = self.transaction().await?;
        let rows: Vec<(Uuid,String)> = sqlx::query_as("WITH expired AS (SELECT id FROM background_jobs WHERE state='running' AND lease_until<=clock_timestamp() AND ($1::text IS NULL OR kind=$1) AND ($2::uuid IS NULL OR id=$2) ORDER BY lease_until LIMIT 100 FOR UPDATE SKIP LOCKED) UPDATE background_jobs j SET state=CASE WHEN EXISTS(SELECT 1 FROM background_job_steps s WHERE s.job_id=j.id AND s.state='started' AND (s.mode='reconcile' OR s.idempotency_until<=clock_timestamp())) THEN 'reconcile' WHEN attempts>=max_attempts THEN 'dead' ELSE 'retry' END, failure_code='LEASE_EXPIRED',lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()+make_interval(secs=>least(3600,30*power(2,least(attempts-1,7)))::int),updated_at=clock_timestamp() FROM expired WHERE j.id=expired.id RETURNING j.id,j.state")
            .bind(kind).bind(id).fetch_all(&mut *tx).await.map_err(failed)?;
        tx.commit().await.map_err(failed)?;
        Ok(rows
            .into_iter()
            .map(|(id, state)| serde_json::json!({"id":id,"state":state}))
            .collect())
    }
    pub async fn claim(&self, kind: &str, id: Option<Uuid>) -> Result<Option<Lease>> {
        if !key(kind) {
            return Err(Code::InvalidInput.into());
        }
        self.reap(Some(kind), id).await?;
        let token = Uuid::new_v4();
        let mut tx = self.transaction().await?;
        let row = sqlx::query("WITH candidate AS (SELECT id FROM background_jobs WHERE kind=$1 AND ($2::uuid IS NULL OR id=$2) AND state IN ('queued','retry') AND available_at<=clock_timestamp() AND attempts<max_attempts ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE background_jobs j SET state='running',attempts=attempts+1,total_attempts=total_attempts+1,generation=generation+1,lease_token=$3,lease_until=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() FROM candidate WHERE j.id=candidate.id RETURNING j.id,j.generation,j.attempts,j.kind,j.input::text,greatest(0,extract(epoch FROM (clock_timestamp()-j.scheduled_at))*1000)::float8 AS queue_age_ms")
            .bind(kind).bind(id).bind(token).fetch_optional(&mut *tx).await.map_err(failed)?;
        let lease = row
            .map(|r| -> Result<Lease> {
                Ok(Lease {
                    id: r.try_get("id").map_err(failed)?,
                    token,
                    generation: r.try_get("generation").map_err(failed)?,
                    attempt: r.try_get("attempts").map_err(failed)?,
                    kind: r.try_get("kind").map_err(failed)?,
                    input: forge_core::json::parse(r.try_get::<&str, _>("input").map_err(failed)?)
                        .map_err(failed)?,
                    queue_age_ms: r.try_get("queue_age_ms").map_err(failed)?,
                })
            })
            .transpose()?;
        tx.commit().await.map_err(failed)?;
        Ok(lease)
    }
    pub async fn heartbeat(&self, lease: &Lease) -> Result<()> {
        let mut tx = self.transaction().await?;
        let found: Option<Uuid> = sqlx::query_scalar("UPDATE background_jobs SET lease_until=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND generation=$3 AND state='running' AND lease_until>clock_timestamp() RETURNING id")
            .bind(lease.id).bind(lease.token).bind(lease.generation).fetch_optional(&mut *tx).await.map_err(failed)?;
        found.ok_or(Code::LeaseLost)?;
        tx.commit().await.map_err(failed)
    }
    pub async fn defer(&self, lease: &Lease) -> Result<()> {
        let mut tx = self.transaction().await?;
        Self::fence(&mut tx, lease, true).await?;
        let found: Option<Uuid> = sqlx::query_scalar("UPDATE background_jobs SET state='queued',available_at=clock_timestamp()+interval '1 minute',attempts=greatest(0,attempts-1),lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_until>clock_timestamp() RETURNING id").bind(lease.id).fetch_optional(&mut *tx).await.map_err(failed)?;
        found.ok_or(Code::LeaseLost)?;
        tx.commit().await.map_err(failed)
    }
    pub async fn sql_step<F>(&self, lease: &Lease, step: &str, run: F) -> Result<Value>
    where
        F: for<'a> FnOnce(&'a mut PgConnection) -> BoxFuture<'a, Result<Value>> + Send,
    {
        self.sql_step_control(lease, step, run).await
    }
    /// Expected deferral can leave this checkpoint uncommitted while preserving
    /// earlier observation checkpoints. The caller retains its typed control flow.
    pub async fn sql_step_control<E, F>(
        &self,
        lease: &Lease,
        step: &str,
        run: F,
    ) -> std::result::Result<Value, E>
    where
        E: From<Error> + Send,
        F: for<'a> FnOnce(&'a mut PgConnection) -> BoxFuture<'a, std::result::Result<Value, E>>
            + Send,
    {
        if !key(step) {
            return Err(Error::from(Code::InvalidInput).into());
        }
        let mut tx = self.transaction().await?;
        Self::fence(&mut tx, lease, true).await?;
        let existing: Option<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT mode,state,result::text FROM background_job_steps WHERE job_id=$1 AND key=$2",
        )
        .bind(lease.id)
        .bind(step)
        .fetch_optional(&mut *tx)
        .await
        .map_err(failed)?;
        if let Some((mode, state, result)) = existing {
            if mode != "transactional" || state != "completed" {
                return Err(Error::from(Code::IdentityConflict).into());
            }
            let result =
                forge_core::json::parse(result.as_deref().unwrap_or("null")).map_err(failed)?;
            tx.commit().await.map_err(failed)?;
            return Ok(result);
        }
        let result = run(&mut tx).await?;
        let body = json(&result)?;
        sqlx::query("INSERT INTO background_job_steps(job_id,key,mode,state,result) VALUES($1,$2,'transactional','completed',$3::jsonb)").bind(lease.id).bind(step).bind(body).execute(&mut *tx).await.map_err(failed)?;
        Self::fence(&mut tx, lease, false).await?;
        tx.commit().await.map_err(failed)?;
        Ok(result)
    }
    pub async fn external_step<F, Fut>(
        &self,
        lease: &Lease,
        step: &str,
        policy: ExternalPolicy,
        run: F,
    ) -> Result<()>
    where
        F: FnOnce(String, Option<chrono::DateTime<chrono::Utc>>) -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        if !key(step) {
            return Err(Code::InvalidInput.into());
        }
        let mode = policy.mode();
        let mut tx = self.transaction().await?;
        Self::fence(&mut tx, lease, true).await?;
        let existing: Option<(String,String,Option<chrono::DateTime<chrono::Utc>>)> = sqlx::query_as("SELECT mode,state,idempotency_until FROM background_job_steps WHERE job_id=$1 AND key=$2").bind(lease.id).bind(step).fetch_optional(&mut *tx).await.map_err(failed)?;
        if let Some((old_mode, state, _)) = &existing {
            if old_mode != mode {
                return Err(Code::IdentityConflict.into());
            }
            if state == "completed" {
                tx.commit().await.map_err(failed)?;
                return Ok(());
            }
            if state == "started" && mode == "reconcile" {
                return Err(Code::ReconciliationRequired.into());
            }
        }
        let deadline = existing.and_then(|(_, _, date)| date).or(match policy {
            ExternalPolicy::ProviderIdempotent { valid_until } => Some(valid_until),
            ExternalPolicy::Reconcile => None,
        });
        if mode == "provider-idempotent" {
            let safe: bool = sqlx::query_scalar("SELECT $1::timestamptz>clock_timestamp()")
                .bind(deadline)
                .fetch_one(&mut *tx)
                .await
                .map_err(failed)?;
            if !safe {
                return Err(Code::ReconciliationRequired.into());
            }
        }
        sqlx::query("INSERT INTO background_job_steps(job_id,key,mode,state,idempotency_until) VALUES($1,$2,$3,'started',$4) ON CONFLICT(job_id,key) DO UPDATE SET state='started',idempotency_until=EXCLUDED.idempotency_until,updated_at=clock_timestamp()")
            .bind(lease.id).bind(step).bind(mode).bind(deadline).execute(&mut *tx).await.map_err(failed)?;
        Self::fence(&mut tx, lease, false).await?;
        tx.commit().await.map_err(failed)?;
        let key = format!(
            "forge-job-{}",
            forge_core::canonical::command_input_hash(
                &serde_json::json!({"job":lease.id,"step":step})
            )
        );
        run(key, deadline).await?;
        let mut tx = self.transaction().await?;
        Self::fence(&mut tx, lease, true).await?;
        sqlx::query("UPDATE background_job_steps SET state='completed',result='null'::jsonb,updated_at=clock_timestamp() WHERE job_id=$1 AND key=$2").bind(lease.id).bind(step).execute(&mut *tx).await.map_err(failed)?;
        Self::fence(&mut tx, lease, false).await?;
        tx.commit().await.map_err(failed)
    }
    pub async fn complete(&self, lease: &Lease) -> Result<()> {
        let mut tx = self.transaction().await?;
        Self::fence(&mut tx, lease, true).await?;
        let pending: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM background_job_steps WHERE job_id=$1 AND state<>'completed')").bind(lease.id).fetch_one(&mut *tx).await.map_err(failed)?;
        if pending {
            return Err(Code::ReconciliationRequired.into());
        }
        let found: Option<Uuid> = sqlx::query_scalar("UPDATE background_jobs SET state='completed',completed_at=clock_timestamp(),updated_at=clock_timestamp(),failure_code=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_until>clock_timestamp() RETURNING id").bind(lease.id).fetch_optional(&mut *tx).await.map_err(failed)?;
        found.ok_or(Code::LeaseLost)?;
        tx.commit().await.map_err(failed)
    }
    pub async fn fail(&self, lease: &Lease, error: Error) -> Result<State> {
        let mut tx = self.transaction().await?;
        Self::fence(&mut tx, lease, true).await?;
        let result: Option<String> = sqlx::query_scalar("UPDATE background_jobs j SET state=CASE WHEN $2 OR EXISTS(SELECT 1 FROM background_job_steps s WHERE s.job_id=j.id AND s.state='started' AND (s.mode='reconcile' OR s.idempotency_until<=clock_timestamp())) THEN 'reconcile' WHEN $3 OR attempts>=max_attempts THEN 'dead' ELSE 'retry' END,failure_code=$4,available_at=clock_timestamp()+make_interval(secs=>least(3600,30*power(2,least(attempts-1,7)))::int),lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 AND lease_until>clock_timestamp() RETURNING state")
            .bind(lease.id).bind(error.code == Code::ReconciliationRequired).bind(error.permanent).bind(error.code.to_string()).fetch_optional(&mut *tx).await.map_err(failed)?;
        let result = state(&result.ok_or(Code::LeaseLost)?)?;
        tx.commit().await.map_err(failed)?;
        Ok(result)
    }
}
