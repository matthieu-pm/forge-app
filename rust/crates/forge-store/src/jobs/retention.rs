use super::*;
use chrono::{DateTime, Duration, Utc};
use runner::{Handler, RunError};
use serde_json::json;

pub const KIND: &str = "workflow-retention-v1";
pub struct WorkflowRetention;
#[async_trait::async_trait]
impl Handler for WorkflowRetention {
    async fn run(&self, store: &JobStore, lease: &Lease) -> std::result::Result<(), RunError> {
        let cutoff = lease
            .input
            .get("cutoff")
            .and_then(Value::as_str)
            .and_then(|value| {
                DateTime::parse_from_rfc3339(value)
                    .map(|v| v.with_timezone(&Utc))
                    .ok()
                    .or_else(|| {
                        chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
                            .ok()?
                            .and_hms_opt(0, 0, 0)
                            .map(|v| v.and_utc())
                    })
            });
        let cutoff = cutoff.ok_or(Error::permanent(Code::InvalidInput))?;
        for batch in 0u64.. {
            store.heartbeat(lease).await?;
            let result = store.sql_step(lease,&format!("batch:{batch}"), move |tx| Box::pin(async move {
                let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM business_workflow_runs WHERE (state IN ('completed','failed','cancelled') AND completed_at<$1::timestamptz) OR (state='failed-to-start' AND updated_at<$1::timestamptz) ORDER BY id LIMIT 500 FOR UPDATE").bind(cutoff).fetch_all(&mut *tx).await.map_err(failed)?;
                if ids.is_empty() { return Ok(json!({"deleted":0})); }
                let deleted = sqlx::query("DELETE FROM business_workflow_runs WHERE id=ANY($1::uuid[]) AND ((state IN ('completed','failed','cancelled') AND completed_at<$2::timestamptz) OR (state='failed-to-start' AND updated_at<$2::timestamptz))").bind(ids).bind(cutoff).execute(&mut *tx).await.map_err(failed)?.rows_affected();
                Ok(json!({"deleted":deleted}))
            })).await?;
            if result["deleted"] == 0 {
                return Ok(());
            }
        }
        Err(Error::from(Code::JobFailed).into())
    }
}
pub async fn enqueue(store: &JobStore, now: DateTime<Utc>) -> Result<Uuid> {
    let scheduled_at = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .ok_or(Code::InvalidInput)?
        .and_utc();
    store
        .enqueue(&Enqueue {
            kind: KIND.into(),
            scope: "global".into(),
            identity: scheduled_at.format("%Y-%m-%d").to_string(),
            scheduled_at,
            input: json!({"cutoff":date(scheduled_at-Duration::days(90))}),
            max_attempts: 5,
        })
        .await
}
pub async fn run(store: &JobStore, now: DateTime<Utc>) -> Result<()> {
    let id = enqueue(store, now).await?;
    for _ in 0..20 {
        let result = runner::run_next(store, KIND, &WorkflowRetention, None).await?;
        if result["state"] == "idle" {
            break;
        }
        if result["state"] != "completed" {
            return Err(Code::JobFailed.into());
        }
    }
    if store.inspect(Some(id)).await?["jobs"][0]["state"] != "completed" {
        return Err(Code::JobFailed.into());
    }
    Ok(())
}
