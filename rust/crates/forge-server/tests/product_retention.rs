use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use forge_server::{desktop_retention, files::storage::Storage};
use forge_store::{
    Database,
    retention::{self, DesktopBlobs, Error},
};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Notify;
use uuid::Uuid;
#[test]
fn desktop_cleanup_requires_explicit_enabled_storage_configuration() {
    assert!(
        desktop_retention::Storage::configured(&HashMap::new())
            .unwrap()
            .is_none()
    );
    let valid = HashMap::from([
        ("FORGE_DESKTOP_RELEASE_ENABLED".into(), "true".into()),
        ("R2_ACCOUNT_ID".into(), "fixture-account".into()),
        (
            "R2_DESKTOP_RELEASE_BUCKET".into(),
            "fixture-releases".into(),
        ),
        ("R2_ACCESS_KEY_ID".into(), "fixture-key".into()),
        ("R2_SECRET_ACCESS_KEY".into(), "fixture-secret".into()),
    ]);
    assert!(desktop_retention::Storage::configured(&valid).is_ok());
    for (key, value) in [
        ("FORGE_DESKTOP_RELEASE_ENABLED", "yes"),
        ("R2_ACCOUNT_ID", "../private"),
        ("R2_DESKTOP_RELEASE_BUCKET", " "),
        ("R2_ACCESS_KEY_ID", ""),
        ("R2_SECRET_ACCESS_KEY", ""),
        ("R2_ENDPOINT", "http://127.0.0.1"),
        ("R2_ENDPOINT", "https://user:secret@example.com"),
        ("R2_ENDPOINT", "https://example.com?token=private"),
    ] {
        let mut env = valid.clone();
        env.insert(key.into(), value.into());
        assert!(
            desktop_retention::Storage::configured(&env).is_err(),
            "{key}"
        );
    }
}
#[tokio::test]
async fn r2_deletion_uses_explicit_credentials_and_checks_per_object_errors() {
    use axum::{
        body::to_bytes, extract::Request, http::StatusCode, response::IntoResponse, routing::any,
    };
    let requests = Arc::new(Mutex::new(vec![]));
    let captures = requests.clone();
    let fail = Arc::new(AtomicBool::new(false));
    let failing = fail.clone();
    let app=axum::Router::new().fallback(any(move|request:Request|{let captures=captures.clone();let fail=failing.clone();async move{
        assert_eq!(request.method(),"POST");assert!(request.uri().path().contains("fixture-releases"));assert!(request.uri().query().unwrap().starts_with("delete"));
        assert!(request.headers()["authorization"].to_str().unwrap().contains("Credential=fixture-key/"));
        let bytes=to_bytes(request.into_body(),128*1024).await.unwrap();captures.lock().unwrap().push(String::from_utf8(bytes.to_vec()).unwrap());
        (StatusCode::OK,[("content-type","application/xml")],if fail.load(Ordering::SeqCst){"<DeleteResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Error><Key>private</Key><Code>AccessDenied</Code><Message>private-provider-detail</Message></Error></DeleteResult>"}else{"<DeleteResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"/>"}).into_response()
    }}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let storage = desktop_retention::Storage::new(
        origin.parse().unwrap(),
        "fixture-releases".into(),
        "fixture-key".into(),
        "fixture-secret".into(),
    )
    .unwrap();
    let keys = vec![
        "desktop/v1.2.3/manifest.json".into(),
        "desktop/v1.2.3/darwin/arm64/Forge.dmg".into(),
    ];
    storage.delete(&keys).await.unwrap();
    fail.store(true, Ordering::SeqCst);
    assert_eq!(
        storage.delete(&keys).await.unwrap_err().to_string(),
        "Product retention failed."
    );
    assert!(storage.delete(&[]).await.is_err());
    assert!(storage.delete(&vec!["key".into(); 1001]).await.is_err());
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    for body in requests.iter() {
        for key in &keys {
            assert!(body.contains(key));
        }
        assert!(body.contains("<Quiet>true</Quiet>"));
        assert!(!body.contains("fixture-secret"));
    }
    server.abort();
}
struct Blobs {
    pool: PgPool,
    fail: AtomicBool,
    pause: AtomicBool,
    entered: Notify,
    resume: Notify,
    keys: Mutex<Vec<Vec<String>>>,
}
#[async_trait]
impl DesktopBlobs for Blobs {
    async fn delete(&self, keys: &[String]) -> Result<(), Error> {
        let version = keys
            .iter()
            .find_map(|k| {
                k.strip_prefix("desktop/v")
                    .and_then(|k| k.strip_suffix("/manifest.json"))
            })
            .unwrap();
        let state: String =
            sqlx::query_scalar("SELECT state FROM desktop_releases WHERE version=$1")
                .bind(version)
                .fetch_one(&self.pool)
                .await
                .unwrap();
        assert_eq!(state, "expiring");
        self.keys.lock().unwrap().push(keys.to_vec());
        if self.pause.swap(false, Ordering::SeqCst) {
            self.entered.notify_one();
            self.resume.notified().await;
        }
        if self.fail.load(Ordering::SeqCst) {
            return Err(Error);
        }
        Ok(())
    }
}
async fn health(pool: &PgPool) -> (Option<DateTime<Utc>>, Option<DateTime<Utc>>) {
    sqlx::query_as(
        "SELECT completed_at,failed_at FROM operational_job_health WHERE key='product.retention'",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}
async fn release(pool: &PgPool, version: &str, state: &str, at: DateTime<Utc>) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO desktop_releases(id,version,state,created_at) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(version)
        .bind(state)
        .bind(at)
        .execute(pool)
        .await
        .unwrap();
    id
}
#[tokio::test]
async fn product_retention_preserves_boundaries_retries_expiring_drafts_and_fences_late_artifacts()
{
    let url = std::env::var("FORGE_RUST_PRODUCT_RETENTION_TEST_DATABASE_URL")
        .expect("Use the disposable PostgreSQL milestone runner");
    let parsed = url::Url::parse(&url).unwrap();
    assert_eq!(parsed.host_str(), Some("127.0.0.1"));
    assert_eq!(parsed.path(), "/forge_rust_product_retention");
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    let db = Database::new(pool.clone());
    let root = std::env::temp_dir().join(format!("forge-product-retention-{}", Uuid::new_v4()));
    tokio::fs::create_dir(&root).await.unwrap();
    let files = Storage::local(&root).unwrap();
    let now = DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap();
    let cutoff = now - Duration::days(30);
    let receipt_cutoff = now - Duration::days(365);
    let user = Uuid::new_v4().to_string();
    let workspace = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,email_verified) VALUES($1,'Retention fixture',$2,true)",
    )
    .bind(&user)
    .bind(format!("{user}@example.test"))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO organization(id,name,slug) VALUES($1,'Retention fixture',$1)")
        .bind(&workspace)
        .execute(&pool)
        .await
        .unwrap();
    let mut teams = vec![];
    for (index, deleted) in [
        Some(cutoff - Duration::milliseconds(1)),
        Some(cutoff),
        Some(now - Duration::days(29)),
        None,
    ]
    .into_iter()
    .enumerate()
    {
        let id = Uuid::new_v4();
        teams.push(id);
        sqlx::query("INSERT INTO teams(id,workspace_id,slug,name,identifier,icon_kind,icon_value,color,timezone,created_by_user_id,deleted_at) VALUES($1,$2,$3,'Retention fixture',$4,'icon','hash','#777777','UTC',$5,$6)").bind(id).bind(&workspace).bind(id.to_string()).bind(format!("RT{index}")).bind(&user).bind(deleted).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO recovery_operations(id,started_at,published_at) SELECT gen_random_uuid(),$1-interval '2 days',$1-interval '1 day' FROM generate_series(1,1001)").bind(receipt_cutoff).execute(&pool).await.unwrap();
    let pending = Uuid::new_v4();
    let boundary = Uuid::new_v4();
    sqlx::query("INSERT INTO recovery_operations(id,started_at,published_at) VALUES($1,$3-interval '10 days',NULL),($2,$3-interval '2 days',$3)").bind(pending).bind(boundary).bind(receipt_cutoff).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO recovery_events(operation_id,table_name,row_key,action) SELECT id,'fixture','{}','delete' FROM recovery_operations").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO business_workflow_runs(workspace_id,kind,subject_type,subject_id,idempotency_key,state,completed_at) SELECT $1,'fixture','fixture',gen_random_uuid()::text,gen_random_uuid()::text,s, $2-interval '100 days' FROM unnest(ARRAY['completed','running']) s").bind(&workspace).bind(now).execute(&pool).await.unwrap();
    let old = release(&pool, "11.0.0", "draft", cutoff - Duration::milliseconds(1)).await;
    let edge = release(&pool, "11.1.0", "draft", cutoff).await;
    let live = release(&pool, "11.2.0", "promoted", cutoff - Duration::days(60)).await;
    let retry = release(&pool, "11.3.0", "expiring", now).await;
    let object = "desktop/v11.0.0/darwin/arm64/Forge.dmg";
    sqlx::query("INSERT INTO desktop_release_artifacts(release_id,platform,architecture,kind,object_key,public_url,sha256,size_bytes) VALUES($1,'darwin','arm64','dmg',$2,'https://example.test/release',$3,1)").bind(old).bind(object).bind("a".repeat(64)).execute(&pool).await.unwrap();
    let report = retention::run_product(&db, &files, None, false, now)
        .await
        .unwrap();
    assert_eq!(report.count, 1);
    assert!(report.successful());
    let first = health(&pool).await;
    assert!(first.0.is_some());
    assert!(first.1.is_none());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM recovery_operations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1003);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM business_workflow_runs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let kept: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM teams")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(kept.len(), 3);
    assert!(!kept.contains(&teams[0]));
    let blobs = Arc::new(Blobs {
        pool: pool.clone(),
        fail: AtomicBool::new(true),
        pause: AtomicBool::new(false),
        entered: Notify::new(),
        resume: Notify::new(),
        keys: Mutex::new(vec![]),
    });
    assert!(
        retention::run_product(&db, &files, Some(blobs.as_ref()), true, now)
            .await
            .is_err()
    );
    let failed = health(&pool).await;
    assert_eq!(failed.0, first.0);
    assert!(failed.1.is_some());
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM recovery_operations WHERE published_at<$1")
            .bind(receipt_cutoff)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
    for id in [old, retry] {
        let state: String = sqlx::query_scalar("SELECT state FROM desktop_releases WHERE id=$1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(state, "expiring");
    }
    blobs.fail.store(false, Ordering::SeqCst);
    let report = retention::run_product(&db, &files, Some(blobs.as_ref()), true, now)
        .await
        .unwrap();
    assert_eq!(report.count, 2);
    assert!(report.successful());
    let kept: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM desktop_releases")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(kept.len(), 2);
    assert!(kept.contains(&edge));
    assert!(kept.contains(&live));
    let kept: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM recovery_operations")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(kept.len(), 2);
    assert!(kept.contains(&pending));
    assert!(kept.contains(&boundary));
    let recovered = health(&pool).await;
    assert!(recovered.0 > failed.0);
    assert_eq!(recovered.1, failed.1);
    assert!(
        blobs
            .keys
            .lock()
            .unwrap()
            .iter()
            .any(|keys| keys.contains(&object.into())
                && keys.contains(&"desktop/v11.0.0/manifest.json".into())
                && keys.contains(&"desktop/v11.0.0/darwin/arm64/SHA256SUMS".into())
                && keys.contains(&"desktop/v11.0.0/darwin/x64/SHA256SUMS".into()))
    );
    let racing = release(&pool, "11.4.0", "draft", cutoff - Duration::days(1)).await;
    blobs.pause.store(true, Ordering::SeqCst);
    let task_db = db.clone();
    let task_files = files.clone();
    let task_blobs = blobs.clone();
    let task = tokio::spawn(async move {
        retention::run_product(&task_db, &task_files, Some(task_blobs.as_ref()), false, now).await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), blobs.entered.notified())
        .await
        .unwrap();
    let late_pool = pool.clone();
    let mut late = tokio::spawn(async move {
        sqlx::query("INSERT INTO desktop_release_artifacts(release_id,platform,architecture,kind,object_key,public_url,sha256,size_bytes) VALUES($1,'darwin','x64','zip','desktop/v11.4.0/darwin/x64/late.zip','https://example.test/late',$2,1)").bind(racing).bind("a".repeat(64)).execute(&late_pool).await
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), &mut late)
            .await
            .is_err()
    );
    blobs.resume.notify_one();
    assert_eq!(task.await.unwrap().unwrap().count, 1);
    assert!(late.await.unwrap().is_err());
    // The actual command uses the same flow with release cleanup disabled.
    let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_forge-retention"))
        .arg("product")
        .env_clear()
        .env("DATABASE_URL", &url)
        .env("FORGE_ENVIRONMENT", "development")
        .env("FORGE_AGENT_ARTIFACT_DIRECTORY", &root)
        .kill_on_drop(true)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report,
        json!({"job":"product.retention","count":1,"failures":0})
    );
    let remaining: i64 =
        sqlx::query_scalar("SELECT count(*) FROM desktop_releases WHERE id=ANY($1::uuid[])")
            .bind(vec![edge, live])
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(remaining, 2);
    pool.close().await;
    tokio::fs::remove_dir_all(root).await.unwrap();
}
