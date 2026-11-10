use async_trait::async_trait;
use forge_core::journal::{
    DeletionJournalBackend, EventBatches, JournalError, JournalSource, RecoveryEvent,
};
use forge_store::{Database, StoreError, accounts};
use futures_util::StreamExt;
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU8, Ordering},
};
use uuid::Uuid;

#[derive(Default)]
struct CaptureJournal {
    mode: AtomicU8,
    prepared: Mutex<Vec<String>>,
    completed: Mutex<Vec<(String, Vec<RecoveryEvent>)>>,
    aborted: Mutex<Vec<String>>,
    settled: tokio::sync::Notify,
}

#[async_trait]
impl DeletionJournalBackend for CaptureJournal {
    async fn prepare(&self, operation: &str, source: &JournalSource) -> Result<(), JournalError> {
        assert_eq!(source.branch_id, "br-local-recovery");
        if self.mode.load(Ordering::Relaxed) == 1 {
            return Err(JournalError::Unavailable);
        }
        self.prepared.lock().unwrap().push(operation.into());
        Ok(())
    }
    async fn complete(
        &self,
        operation: &str,
        _source: &JournalSource,
        mut batches: EventBatches,
    ) -> Result<(), JournalError> {
        let mut events = Vec::new();
        while let Some(batch) = batches.next().await {
            events.extend(batch?);
        }
        if self.mode.load(Ordering::Relaxed) == 2 {
            return Err(JournalError::Unavailable);
        }
        self.completed
            .lock()
            .unwrap()
            .push((operation.into(), events));
        self.settled.notify_one();
        Ok(())
    }
    async fn abort(&self, operation: &str, _source: &JournalSource) -> Result<(), JournalError> {
        self.aborted.lock().unwrap().push(operation.into());
        self.settled.notify_one();
        Ok(())
    }
}

struct Fixture {
    pool: PgPool,
    database: Database,
    backend: Arc<CaptureJournal>,
    token: String,
    user_id: String,
}

impl Fixture {
    async fn new() -> Self {
        let connection = std::env::var("FORGE_RUST_JOURNAL_TEST_DATABASE_URL")
            .expect("Run bun run rewrite:verify");
        let options: sqlx::postgres::PgConnectOptions = connection.parse().unwrap();
        assert_eq!(options.get_host(), "127.0.0.1");
        assert_eq!(options.get_database(), Some("forge_rust_journal"));
        assert_eq!(options.get_username(), "forge_rust_test");
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .after_connect(|connection, _| {
                Box::pin(async move {
                    sqlx::query("SELECT set_config('neon.branch_id','br-local-recovery',false)")
                        .execute(connection)
                        .await?;
                    Ok(())
                })
            })
            .connect_with(options)
            .await
            .unwrap();
        let backend = Arc::new(CaptureJournal::default());
        let database =
            Database::with_journal(pool.clone(), backend.clone(), "store_localtest".into());
        let user_id = Uuid::new_v4().to_string();
        let token = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO \"user\"(id,name,email,email_verified) VALUES($1,'Test account',$2,true)",
        )
        .bind(&user_id)
        .bind(format!("{user_id}@example.test"))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO session(id,token,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')").bind(Uuid::new_v4().to_string()).bind(&token).bind(&user_id).execute(&pool).await.unwrap();
        Self {
            pool,
            database,
            backend,
            token,
            user_id,
        }
    }
    async fn session_exists(&self) -> bool {
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session WHERE token=$1)")
            .bind(&self.token)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn independent_prepare_and_complete_surround_a_committed_deletion() {
    let fixture = Fixture::new().await;
    accounts::sign_out(&fixture.database, &fixture.token)
        .await
        .unwrap();
    assert!(!fixture.session_exists().await);
    let prepared = fixture.backend.prepared.lock().unwrap().clone();
    assert_eq!(prepared.len(), 1);
    let completed = fixture.backend.completed.lock().unwrap().clone();
    assert_eq!(completed.len(), 1);
    assert_eq!(completed[0].0, prepared[0]);
    assert_eq!(completed[0].1.len(), 1);
    let event = &completed[0].1[0];
    assert_eq!(event.table, "session");
    assert!(event.patch.is_none());
    assert!(
        !serde_json::to_string(event)
            .unwrap()
            .contains(&fixture.token)
    );
    let published: bool =
        sqlx::query_scalar("SELECT published_at IS NOT NULL FROM recovery_operations WHERE id=$1")
            .bind(Uuid::parse_str(&prepared[0]).unwrap())
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert!(published);
    assert!(fixture.backend.aborted.lock().unwrap().is_empty());
}

#[tokio::test]
async fn failed_prepare_prevents_the_sql_effect() {
    let fixture = Fixture::new().await;
    fixture.backend.mode.store(1, Ordering::Relaxed);
    assert!(matches!(
        accounts::sign_out(&fixture.database, &fixture.token).await,
        Err(StoreError::Recovery(JournalError::Unavailable))
    ));
    assert!(fixture.session_exists().await);
    assert!(fixture.backend.completed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn failed_publication_leaves_the_committed_operation_pending_not_aborted() {
    let fixture = Fixture::new().await;
    fixture.backend.mode.store(2, Ordering::Relaxed);
    assert!(matches!(
        accounts::sign_out(&fixture.database, &fixture.token).await,
        Err(StoreError::Recovery(JournalError::PublicationPending))
    ));
    assert!(!fixture.session_exists().await);
    let prepared = fixture.backend.prepared.lock().unwrap().clone();
    assert_eq!(prepared.len(), 1);
    let unpublished: bool =
        sqlx::query_scalar("SELECT published_at IS NULL FROM recovery_operations WHERE id=$1")
            .bind(Uuid::parse_str(&prepared[0]).unwrap())
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert!(unpublished);
    assert!(fixture.backend.aborted.lock().unwrap().is_empty());
    assert!(fixture.backend.completed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn explicit_rollback_publishes_an_abort_and_restores_the_row() {
    let fixture = Fixture::new().await;
    let mut tx = fixture.database.begin().await.unwrap();
    tx.prepare().await.unwrap();
    sqlx::query("DELETE FROM session WHERE token=$1")
        .bind(&fixture.token)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert!(fixture.session_exists().await);
    assert_eq!(fixture.backend.aborted.lock().unwrap().len(), 1);
    assert!(fixture.backend.completed.lock().unwrap().is_empty());
}

#[tokio::test]
async fn dropped_transactions_abort_only_after_database_rollback() {
    let fixture = Fixture::new().await;
    {
        let mut tx = fixture.database.begin().await.unwrap();
        tx.prepare().await.unwrap();
        sqlx::query("DELETE FROM session WHERE token=$1")
            .bind(&fixture.token)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        fixture.backend.settled.notified(),
    )
    .await
    .unwrap();
    assert!(fixture.session_exists().await);
    assert_eq!(fixture.backend.aborted.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn enabled_capture_requires_a_configured_independent_backend() {
    let fixture = Fixture::new().await;
    let unconfigured = Database::new(fixture.pool.clone());
    assert!(matches!(
        accounts::sign_out(&unconfigured, &fixture.token).await,
        Err(StoreError::Recovery(JournalError::Unavailable))
    ));
    assert!(fixture.session_exists().await);
}

#[tokio::test]
async fn verification_updates_are_captured_without_journaling_credentials() {
    let fixture = Fixture::new().await;
    let mut tx = fixture.database.begin().await.unwrap();
    tx.prepare().await.unwrap();
    sqlx::query("UPDATE \"user\" SET email_verified=false WHERE id=$1")
        .bind(&fixture.user_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let completed = fixture.backend.completed.lock().unwrap().clone();
    let events = &completed[0].1;
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0].patch.as_ref().unwrap().get("email_verified"),
        Some(&serde_json::json!(false))
    );
}
