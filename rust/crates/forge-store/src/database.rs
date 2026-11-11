//! One mutation transaction owns both PostgreSQL state and independent recovery
//! publication. Prepare precedes destructive SQL; acknowledgement follows archive
//! completion. Unknown commit/publication outcomes are never reported as aborted.

use crate::StoreError;
use forge_core::journal::{
    DeletionJournalBackend, EventBatches, JournalError, JournalSource, RecoveryEvent,
};
use sqlx::{PgConnection, PgPool, Postgres, Transaction};
use std::{
    ops::{Deref, DerefMut},
    sync::Arc,
};
use uuid::Uuid;

#[derive(Clone)]
pub struct Database {
    pool: PgPool,
    journal: Option<Arc<dyn DeletionJournalBackend>>,
    store_id: String,
    sla_gate: Option<Arc<SlaGate>>,
}
type SlaGate = dyn Fn(&str) -> (bool, String) + Send + Sync;

impl Database {
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            journal: None,
            store_id: String::new(),
            sla_gate: None,
        }
    }
    pub fn with_journal(
        pool: PgPool,
        journal: Arc<dyn DeletionJournalBackend>,
        store_id: String,
    ) -> Self {
        Self {
            pool,
            journal: Some(journal),
            store_id,
            sla_gate: None,
        }
    }
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }
    /// One gate provider serves policy, ordinary commands and background jobs.
    /// Defaults to the process's explicit deployment/workspace rollout settings.
    pub fn with_sla_gate(mut self, gate: Arc<SlaGate>) -> Self {
        self.sla_gate = Some(gate);
        self
    }
    pub(crate) fn sla_gate(&self, workspace: &str) -> (bool, String) {
        self.sla_gate.as_ref().map_or_else(
            || crate::commands::sla_gate(workspace),
            |gate| gate(workspace),
        )
    }
    pub async fn begin(&self) -> Result<JournalTransaction, StoreError> {
        Ok(JournalTransaction {
            transaction: Some(self.pool.begin().await?),
            database: self.clone(),
            prepared: None,
        })
    }
}

pub struct JournalTransaction {
    transaction: Option<Transaction<'static, Postgres>>,
    database: Database,
    prepared: Option<(Uuid, JournalSource)>,
}

impl Deref for JournalTransaction {
    type Target = PgConnection;
    fn deref(&self) -> &PgConnection {
        self.transaction.as_ref().expect("open transaction")
    }
}
impl DerefMut for JournalTransaction {
    fn deref_mut(&mut self) -> &mut PgConnection {
        self.transaction.as_mut().expect("open transaction")
    }
}

impl JournalTransaction {
    pub async fn prepare(&mut self) -> Result<(), StoreError> {
        if self.prepared.is_some() {
            return Ok(());
        }
        let row:(String,Option<String>,Option<bool>,i64)=sqlx::query_as(r#"SELECT current_database(),current_setting('neon.branch_id',true),
            (SELECT enabled FROM recovery_journal_state WHERE id='singleton'),
            (SELECT count(*) FROM pg_tables t JOIN pg_class c ON c.relname=t.tablename JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname=t.schemaname
             WHERE t.schemaname='public' AND t.tablename NOT LIKE 'recovery\_%' ESCAPE '\' AND
               (NOT EXISTS(SELECT 1 FROM pg_trigger g WHERE g.tgrelid=c.oid AND g.tgname='forge_recovery_capture' AND g.tgenabled<>'D') OR
                NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary)))"#)
            .fetch_one(&mut **self).await?;
        if row.2 != Some(true) && self.database.journal.is_none() {
            return Ok(());
        }
        if row.2 != Some(true) || row.3 != 0 {
            return Err(JournalError::Source.into());
        }
        let backend = self
            .database
            .journal
            .clone()
            .ok_or(JournalError::Unavailable)?;
        let source = JournalSource {
            branch_id: row.1.ok_or(JournalError::Source)?,
            host: self
                .database
                .pool
                .connect_options()
                .get_host()
                .replace("-pooler.", "."),
            database: row.0,
            store_id: self.database.store_id.clone(),
        };
        let operation = Uuid::new_v4();
        backend.prepare(&operation.to_string(), &source).await?;
        // Retain the prepared identity even if the SQL reservation fails, so a
        // confirmed rollback can publish its abort through the independent store.
        self.prepared = Some((operation, source));
        sqlx::query("INSERT INTO recovery_operations(id) VALUES($1)")
            .bind(operation)
            .execute(&mut **self)
            .await?;
        sqlx::query("SELECT set_config('forge.recovery_operation',$1,true)")
            .bind(operation.to_string())
            .execute(&mut **self)
            .await?;
        Ok(())
    }

    pub async fn commit(mut self) -> Result<(), StoreError> {
        let transaction = self.transaction.take().expect("open transaction");
        // If the COMMIT response is lost, leave the prepared record unresolved.
        transaction.commit().await?;
        if let Some((operation, source)) = &self.prepared {
            let backend = self
                .database
                .journal
                .as_ref()
                .ok_or(JournalError::PublicationPending)?;
            backend
                .complete(
                    &operation.to_string(),
                    source,
                    operation_events(self.database.pool.clone(), *operation),
                )
                .await
                .map_err(|_| JournalError::PublicationPending)?;
            sqlx::query("UPDATE recovery_operations SET published_at=COALESCE(published_at,clock_timestamp()) WHERE id=$1")
                .bind(operation).execute(&self.database.pool).await.map_err(|_|JournalError::PublicationPending)?;
        }
        Ok(())
    }

    pub async fn rollback(mut self) -> Result<(), StoreError> {
        self.transaction
            .take()
            .expect("open transaction")
            .rollback()
            .await?;
        if let Some((operation, source)) = &self.prepared {
            self.database
                .journal
                .as_ref()
                .ok_or(JournalError::Unavailable)?
                .abort(&operation.to_string(), source)
                .await?;
        }
        Ok(())
    }
}

impl Drop for JournalTransaction {
    fn drop(&mut self) {
        let Some(transaction) = self.transaction.take() else {
            return;
        };
        let Some((operation, source)) = self.prepared.take() else {
            drop(transaction);
            return;
        };
        let Some(backend) = self.database.journal.clone() else {
            drop(transaction);
            return;
        };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                if transaction.rollback().await.is_ok() {
                    let _ = backend.abort(&operation.to_string(), &source).await;
                }
            });
        } else {
            // SQLx schedules rollback; the prepared journal remains available
            // for reconciliation if shutdown prevents publication of the abort.
            drop(transaction);
        }
    }
}

fn operation_events(pool: PgPool, operation: Uuid) -> EventBatches {
    Box::pin(futures_util::stream::try_unfold(
        (pool, 0i64),
        move |(pool, sequence)| async move {
            let rows:Vec<serde_json::Value>=sqlx::query_scalar(r#"SELECT jsonb_build_object('id',id,'sequence',sequence,'table',table_name,'key',row_key,'action',action,'patch',patch,'storageReference',storage_reference,
            'at',to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
            FROM recovery_events WHERE operation_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 1000"#)
            .bind(operation).bind(sequence).fetch_all(&pool).await.map_err(|_|JournalError::Unavailable)?;
            if rows.is_empty() {
                return Ok(None);
            }
            let mut batch = Vec::<RecoveryEvent>::new();
            for row in rows {
                let event: RecoveryEvent =
                    serde_json::from_value(row).map_err(|_| JournalError::Shape)?;
                event.validate()?;
                batch.push(event);
            }
            let last = batch.last().ok_or(JournalError::Shape)?.sequence;
            Ok(Some((batch, (pool, last))))
        },
    ))
}
