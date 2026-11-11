//! Read-only health snapshots and operational freshness. Domain state and job
//! leases are never repaired or advanced by a health check.
use crate::{Database, StoreError};
use chrono::{DateTime, Utc};
use forge_core::workflow_health::{Code, Run};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

pub(crate) async fn heartbeat(db: &Database, key: &str, success: bool) -> Result<(), StoreError> {
    sqlx::query("INSERT INTO operational_job_health(key,completed_at,failed_at) VALUES($1,CASE WHEN $2 THEN clock_timestamp() END,CASE WHEN NOT $2 THEN clock_timestamp() END) ON CONFLICT(key) DO UPDATE SET completed_at=CASE WHEN $2 THEN clock_timestamp() ELSE operational_job_health.completed_at END,failed_at=CASE WHEN NOT $2 THEN clock_timestamp() ELSE operational_job_health.failed_at END")
        .bind(key).bind(success).execute(db.pool()).await?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub code: Code,
    pub business_run_id: Uuid,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<Uuid>,
}
#[derive(Debug, Serialize)]
pub struct Report {
    /// Preserve the source's count of missing SDK owners.
    pub count: usize,
    pub inspected: usize,
    pub failures: usize,
    pub issues: Vec<Issue>,
    pub omitted: usize,
}
impl Report {
    pub fn successful(&self) -> bool {
        self.failures == 0
    }
}

pub async fn workflows(db: &Database, now: DateTime<Utc>) -> Result<Report, StoreError> {
    let result = tokio::time::timeout(std::time::Duration::from_secs(60), collect(db, now))
        .await
        .map_err(|_| StoreError::Job(forge_core::jobs::Code::JobFailed.into()))
        .and_then(|result| result);
    heartbeat(
        db,
        "workflow.health",
        result.as_ref().is_ok_and(Report::successful),
    )
    .await?;
    result
}
async fn collect(db: &Database, now: DateTime<Utc>) -> Result<Report, StoreError> {
    let mut tx = db.pool().begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='30s'")
        .execute(&mut *tx)
        .await?;
    let mut after: Option<Uuid> = None;
    let mut report = Report {
        count: 0,
        inspected: 0,
        failures: 0,
        issues: Vec::new(),
        omitted: 0,
    };
    loop {
        let rows: Vec<Value> = sqlx::query_scalar(r#"
            SELECT jsonb_build_object(
              'id',r.id,'workspaceId',r.workspace_id,'kind',r.kind,'state',r.state,
              'sdkRunId',r.sdk_run_id,'createdAt',r.created_at,'startedAt',r.started_at,
              'initial',CASE WHEN i.id IS NOT NULL THEN jsonb_build_object('state',i.state,'completedAt',i.completed_at) END,
              'reminder',CASE WHEN m.id IS NOT NULL THEN jsonb_build_object('state',m.state,'completedAt',m.completed_at) END,
              'job',CASE WHEN j.id IS NOT NULL THEN jsonb_build_object('id',j.id,'kind',j.kind,'scope',j.scope,'identity',j.identity,'state',j.state,'availableAt',j.available_at,'leaseUntil',j.lease_until) END
            )
            FROM business_workflow_runs r
            LEFT JOIN LATERAL (SELECT id,state,completed_at FROM business_workflow_effects WHERE business_run_id=r.id AND position(':initial:' in effect_key)>0 ORDER BY created_at,id LIMIT 1) i ON true
            LEFT JOIN LATERAL (SELECT id,state,completed_at FROM business_workflow_effects WHERE business_run_id=r.id AND position(':reminder-24h:' in effect_key)>0 ORDER BY created_at,id LIMIT 1) m ON true
            LEFT JOIN background_jobs j ON j.id=CASE WHEN r.sdk_run_id ~ '^forge-native-job:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN split_part(r.sdk_run_id,':',2)::uuid END
            WHERE r.state<>'completed' AND ($1::uuid IS NULL OR r.id>$1)
            ORDER BY r.id LIMIT 1000
        "#).bind(after).fetch_all(&mut *tx).await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            let run: Run = serde_json::from_value(row).map_err(|_| StoreError::InvalidInput)?;
            after = Some(run.id);
            report.inspected += 1;
            if let Some(code) = forge_core::workflow_health::classify(&run, now) {
                report.failures += 1;
                report.count += usize::from(code == Code::SdkRunIdMissing);
                if report.issues.len() < 1000 {
                    report.issues.push(Issue {
                        code,
                        business_run_id: run.id,
                        state: run.state,
                        job_id: run.job.map(|job| job.id),
                    });
                } else {
                    report.omitted += 1;
                }
            }
        }
    }
    tx.commit().await?;
    Ok(report)
}
