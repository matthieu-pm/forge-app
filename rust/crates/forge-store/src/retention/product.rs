use super::{Report, heartbeat};
use crate::{
    Database, StoreError,
    issues::purge,
    jobs::{JobStore, retention as workflow},
};
use chrono::{DateTime, Duration, Utc};
use forge_core::files::upload::Transport;
use uuid::Uuid;
#[derive(Debug, thiserror::Error)]
#[error("Product retention failed.")]
pub struct Error;
#[async_trait::async_trait]
pub trait DesktopBlobs: Send + Sync {
    async fn delete(&self, keys: &[String]) -> Result<(), Error>;
}
/// The cutoffs are frozen for this execution. Unpublished recovery operations,
/// active teams and non-draft desktop releases never qualify through age alone.
pub async fn run_product(
    db: &Database,
    files: &dyn Transport,
    desktop: Option<&dyn DesktopBlobs>,
    recovery_enabled: bool,
    now: DateTime<Utc>,
) -> Result<Report, Error> {
    let result = run(db, files, desktop, recovery_enabled, now).await;
    heartbeat(
        db,
        "product.retention",
        result.as_ref().is_ok_and(Report::successful),
    )
    .await
    .map_err(|_| Error)?;
    result
}
async fn run(
    db: &Database,
    files: &dyn Transport,
    desktop: Option<&dyn DesktopBlobs>,
    recovery_enabled: bool,
    now: DateTime<Utc>,
) -> Result<Report, Error> {
    let cutoff = now.checked_sub_signed(Duration::days(30)).ok_or(Error)?;
    let issues = purge::purge(db, files, 25).await.map_err(|_| Error)?;
    if recovery_enabled {
        prune_receipts(
            db,
            now.checked_sub_signed(Duration::days(365)).ok_or(Error)?,
        )
        .await
        .map_err(|_| Error)?;
    }
    workflow::run(&JobStore::new(db.clone()), now)
        .await
        .map_err(|_| Error)?;
    let teams = prune_teams(db, cutoff).await.map_err(|_| Error)?;
    let releases = if let Some(blobs) = desktop {
        prune_releases(db, blobs, cutoff).await?
    } else {
        0
    };
    Ok(Report {
        count: issues.purged as usize + teams as usize + releases,
        failures: issues.failed as usize,
    })
}
async fn prune_receipts(db: &Database, cutoff: DateTime<Utc>) -> Result<(), StoreError> {
    // Internal journal bookkeeping is deliberately outside its own capture path.
    let mut tx = db.pool().begin().await?;
    let ids:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM recovery_operations WHERE published_at<$1 ORDER BY published_at,id LIMIT 1000 FOR UPDATE").bind(cutoff).fetch_all(&mut *tx).await?;
    if !ids.is_empty() {
        sqlx::query("DELETE FROM recovery_events WHERE operation_id=ANY($1::uuid[])")
            .bind(&ids)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM recovery_operations WHERE id=ANY($1::uuid[]) AND published_at<$2")
            .bind(&ids)
            .bind(cutoff)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}
async fn prune_teams(db: &Database, cutoff: DateTime<Utc>) -> Result<u64, StoreError> {
    let mut tx = db.begin().await?;
    tx.prepare().await?;
    let deleted = sqlx::query("DELETE FROM teams WHERE deleted_at<$1")
        .bind(cutoff)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    tx.commit().await?;
    Ok(deleted)
}
async fn prune_releases(
    db: &Database,
    blobs: &dyn DesktopBlobs,
    cutoff: DateTime<Utc>,
) -> Result<usize, Error> {
    let mut tx = db.begin().await.map_err(|_| Error)?;
    tx.prepare().await.map_err(|_| Error)?;
    sqlx::query(
        "UPDATE desktop_releases SET state='expiring' WHERE state='draft' AND created_at<$1",
    )
    .bind(cutoff)
    .execute(&mut *tx)
    .await
    .map_err(|_| Error)?;
    tx.commit().await.map_err(|_| Error)?;
    let ids: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM desktop_releases WHERE state='expiring' ORDER BY id")
            .fetch_all(db.pool())
            .await
            .map_err(|_| Error)?;
    let mut deleted = 0;
    for id in ids {
        let mut tx = db.begin().await.map_err(|_| Error)?;
        // Block late artifact insertions through the parent FK, as well as
        // concurrent publication, until deletion either commits or rolls back.
        let version: Option<String> = sqlx::query_scalar(
            "SELECT version FROM desktop_releases WHERE id=$1 AND state='expiring' FOR UPDATE",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| Error)?;
        let Some(version) = version else {
            tx.commit().await.map_err(|_| Error)?;
            continue;
        };
        let mut keys:Vec<String>=sqlx::query_scalar("SELECT object_key FROM desktop_release_artifacts WHERE release_id=$1 ORDER BY object_key FOR UPDATE").bind(id).fetch_all(&mut *tx).await.map_err(|_|Error)?;
        keys.extend([
            format!("desktop/v{version}/manifest.json"),
            format!("desktop/v{version}/darwin/arm64/SHA256SUMS"),
            format!("desktop/v{version}/darwin/x64/SHA256SUMS"),
        ]);
        tx.prepare().await.map_err(|_| Error)?;
        blobs.delete(&keys).await?;
        deleted += sqlx::query("DELETE FROM desktop_releases WHERE id=$1 AND state='expiring'")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|_| Error)?
            .rows_affected() as usize;
        tx.commit().await.map_err(|_| Error)?;
    }
    Ok(deleted)
}
