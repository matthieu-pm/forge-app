//! Scheduled agent-file retention. Successful freshness advances only after all
//! three sweeps have settled, including any per-object failures.
use super::files::Service;
use crate::StoreError;
use chrono::{DateTime, Utc};
use forge_core::files::upload;
use serde::Serialize;
#[derive(Debug, Serialize)]
pub struct Report {
    pub count: usize,
    pub failures: usize,
}
impl Report {
    pub fn successful(&self) -> bool {
        self.failures == 0
    }
}
pub async fn run(
    files: &Service,
    uploads: &upload::Service,
    before: DateTime<Utc>,
) -> Result<Report, StoreError> {
    // Await every independent sweep even if another one fails; cancellation of
    // still-running cleanup must not escape the scheduled process's lifetime.
    let (artifacts, attachments, uploads) = tokio::join!(
        files.sweep_artifacts(before, 1000),
        files.sweep_attachments(before, 1000),
        uploads.sweep(before, 1000)
    );
    let result = (|| {
        let artifacts = artifacts?;
        let attachments = attachments?;
        let uploads = uploads?;
        let count = uploads["deleted"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or(StoreError::InvalidInput)?;
        let failures = uploads["failures"]
            .as_array()
            .ok_or(StoreError::InvalidInput)?
            .len();
        Ok::<_, StoreError>(Report {
            count: artifacts.deleted + attachments.deleted + count,
            failures: artifacts.failures.len() + attachments.failures.len() + failures,
        })
    })();
    let success = result.as_ref().is_ok_and(Report::successful);
    sqlx::query("INSERT INTO operational_job_health(key,completed_at,failed_at) VALUES('agent.retention',CASE WHEN $1 THEN clock_timestamp() END,CASE WHEN NOT $1 THEN clock_timestamp() END) ON CONFLICT(key) DO UPDATE SET completed_at=CASE WHEN $1 THEN clock_timestamp() ELSE operational_job_health.completed_at END,failed_at=CASE WHEN NOT $1 THEN clock_timestamp() ELSE operational_job_health.failed_at END")
        .bind(success).execute(files.database.pool()).await?;
    result
}
