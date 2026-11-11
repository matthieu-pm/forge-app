use super::*;
use serde_json::json;

impl JobStore {
    /// Operator inspection never exposes inputs, step results, lease tokens or
    /// exceptions. The database identity recorded on recovery is session_user.
    pub async fn inspect(&self, id: Option<Uuid>) -> Result<Value> {
        let jobs: Vec<Value> = sqlx::query_scalar(r#"SELECT jsonb_build_object('id',id,'kind',kind,'state',state,
            'scheduled_at',to_char(scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'available_at',to_char(available_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'attempts',attempts,'total_attempts',total_attempts,'max_attempts',max_attempts,'generation',generation,
            'lease_until',to_char(lease_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'failure_code',failure_code,
            'created_at',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'updated_at',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'completed_at',to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
            FROM background_jobs WHERE ($1::uuid IS NULL OR id=$1) ORDER BY created_at DESC,id LIMIT 100"#)
            .bind(id).fetch_all(self.database.pool()).await.map_err(failed)?;
        let steps: Vec<Value> = if let Some(id) = id {
            sqlx::query_scalar(r#"SELECT jsonb_build_object('key',key,'mode',mode,'state',state,'updated_at',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM background_job_steps WHERE job_id=$1 ORDER BY (state='started') DESC,updated_at DESC,key LIMIT 100"#)
                .bind(id).fetch_all(self.database.pool()).await.map_err(failed)?
        } else {
            Vec::new()
        };
        Ok(json!({"jobs":jobs,"steps":steps}))
    }
    pub async fn recover(&self, input: &Recovery) -> Result<Value> {
        let mut tx = self.transaction().await?;
        let row: Option<(String, i32)> =
            sqlx::query_as("SELECT state,generation FROM background_jobs WHERE id=$1 FOR UPDATE")
                .bind(input.job_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(failed)?;
        let (state, generation) = row.ok_or(Code::RecoveryConflict)?;
        let fingerprint = input.fingerprint();
        let (action, step, outcome, evidence) = match &input.action {
            RecoveryAction::Replay => ("replay", None, None, None),
            RecoveryAction::Resolve {
                step,
                completed,
                evidence,
            } => (
                "resolve",
                Some(step),
                Some(if *completed {
                    "completed"
                } else {
                    "retry-safe"
                }),
                Some(evidence),
            ),
        };
        let reserved: Option<Uuid> = sqlx::query_scalar("INSERT INTO background_job_recoveries(request_id,job_id,input_hash,operator_id,action,reason,step,outcome,evidence,quiesced) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING request_id")
            .bind(input.request_id).bind(input.job_id).bind(&fingerprint).bind(input.operator_id).bind(action).bind(&input.reason).bind(step).bind(outcome).bind(evidence).bind(action == "resolve").fetch_optional(&mut *tx).await.map_err(failed)?;
        if reserved.is_none() {
            let hash: Option<String> = sqlx::query_scalar(
                "SELECT input_hash FROM background_job_recoveries WHERE request_id=$1",
            )
            .bind(input.request_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(failed)?;
            if hash.as_deref() != Some(&fingerprint) {
                return Err(Code::RecoveryConflict.into());
            }
            tx.commit().await.map_err(failed)?;
            return Ok(json!({"replayed":true}));
        }
        if i64::from(generation) != input.generation
            || !["dead", "reconcile"].contains(&state.as_str())
        {
            return Err(Code::RecoveryConflict.into());
        }
        if let RecoveryAction::Resolve {
            step, completed, ..
        } = &input.action
        {
            let resolved: Option<String> = sqlx::query_scalar("UPDATE background_job_steps SET state=$3,idempotency_until=CASE WHEN $3='pending' THEN NULL ELSE idempotency_until END,result=CASE WHEN $3='completed' THEN 'null'::jsonb ELSE NULL END,updated_at=clock_timestamp() WHERE job_id=$1 AND key=$2 AND state='started' AND mode<>'transactional' RETURNING key")
                .bind(input.job_id).bind(step).bind(if *completed { "completed" } else { "pending" }).fetch_optional(&mut *tx).await.map_err(failed)?;
            resolved.ok_or(Code::RecoveryConflict)?;
        } else {
            let pending: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM background_job_steps WHERE job_id=$1 AND state='started' AND mode<>'transactional')").bind(input.job_id).fetch_one(&mut *tx).await.map_err(failed)?;
            if pending {
                return Err(Code::ReconciliationRequired.into());
            }
        }
        // Resolving ambiguity records evidence; replay is a separate operation.
        sqlx::query("UPDATE background_jobs SET generation=generation+1,updated_at=clock_timestamp(),state=CASE WHEN $2 THEN 'queued' ELSE state END,attempts=CASE WHEN $2 THEN 0 ELSE attempts END,available_at=CASE WHEN $2 THEN clock_timestamp() ELSE available_at END WHERE id=$1")
            .bind(input.job_id).bind(action == "replay").execute(&mut *tx).await.map_err(failed)?;
        tx.commit().await.map_err(failed)?;
        Ok(json!({"replayed":false}))
    }
}
