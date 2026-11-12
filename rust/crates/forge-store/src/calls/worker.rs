use super::*;
#[derive(Default, Debug, serde::Serialize)]
pub struct Report {
    pub imported: u64,
    pub expired: u64,
    pub summarized: u64,
    pub failures: u64,
}
impl Service {
    /// Explicit operator invocation. A failing provider or recap must not starve
    /// other workspaces; each operation owns its independently durable lease.
    pub async fn run(&self) -> Result<Report, StoreError> {
        let result = self.run_inner().await;
        crate::operational_health::heartbeat(
            &self.database,
            "calls.sync",
            result.as_ref().is_ok_and(|r| r.failures == 0),
        )
        .await?;
        result
    }
    async fn run_inner(&self) -> Result<Report, StoreError> {
        let mut report = Report {
            expired: self.sweep(None).await?,
            ..Default::default()
        };
        let ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT id FROM call_connections WHERE secret IS NOT NULL ORDER BY id",
        )
        .fetch_all(self.database.pool())
        .await?;
        for id in ids {
            match self.sync_connection(id, None).await {
                Ok(count) => report.imported += count,
                Err(_) => report.failures += 1,
            }
        }
        let ids: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM calls WHERE status='ready' AND summary_status IN ('pending','error') ORDER BY id").fetch_all(self.database.pool()).await?;
        for id in ids {
            match self.summarize_call(id, None).await {
                Ok(changed) => report.summarized += u64::from(changed),
                Err(_) => report.failures += 1,
            }
        }
        Ok(report)
    }
}
