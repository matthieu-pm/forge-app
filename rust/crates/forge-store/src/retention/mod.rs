//! Monitored retention of completed product data and expired publication drafts.
mod product;
use crate::{Database, StoreError};
pub use product::{DesktopBlobs, Error, run_product};
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
pub(crate) async fn heartbeat(db: &Database, key: &str, success: bool) -> Result<(), StoreError> {
    sqlx::query("INSERT INTO operational_job_health(key,completed_at,failed_at) VALUES($1,CASE WHEN $2 THEN clock_timestamp() END,CASE WHEN NOT $2 THEN clock_timestamp() END) ON CONFLICT(key) DO UPDATE SET completed_at=CASE WHEN $2 THEN clock_timestamp() ELSE operational_job_health.completed_at END,failed_at=CASE WHEN NOT $2 THEN clock_timestamp() ELSE operational_job_health.failed_at END")
        .bind(key).bind(success).execute(db.pool()).await?;
    Ok(())
}
