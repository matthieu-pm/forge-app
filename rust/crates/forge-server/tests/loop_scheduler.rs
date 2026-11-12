use axum::{
    body::{Body, to_bytes},
    http::{Method, Request, StatusCode},
    response::Response,
};
use forge_server::{
    loops::handle_scheduler,
    state::{AppState, AuthSettings},
};
use forge_store::{
    Database, StoreError,
    loops::{DispatchReport, Options, Service},
};
use serde_json::{Value, json};
use std::{collections::HashMap, process::Command};
use tower::ServiceExt;
use uuid::Uuid;
const SECRET: &str = "scheduler-local-fixture-secret-at-least-32";
fn options(enabled: bool) -> Options {
    Options::from_environment(HashMap::from([
        ("FORGE_LOOPS_ENABLED".into(), enabled.to_string()),
        ("NODE_ENV".into(), "test".into()),
        ("AGENT_FAKE_RUNTIME_ENABLED".into(), "true".into()),
        ("CRON_SECRET".into(), SECRET.into()),
    ]))
}
async fn body(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap()
}
fn request(method: Method, credential: &str) -> Request<Body> {
    Request::builder()
        .uri("/api/internal/loops")
        .method(method)
        .header("authorization", credential)
        .body(Body::empty())
        .unwrap()
}
fn command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_forge-loops"));
    command.env_clear();
    command
}
#[tokio::test]
async fn scheduler_rejects_credentials_before_work_and_keeps_disabled_ticks_database_free() {
    for enabled in [false, true] {
        for method in [Method::GET, Method::POST, Method::PUT, Method::HEAD] {
            for supplied in [
                String::new(),
                "Bearer wrong".into(),
                SECRET.into(),
                format!("Bearer {SECRET}"),
            ] {
                let authorized = supplied == SECRET || supplied == format!("Bearer {SECRET}");
                let method_ok = method == Method::GET || method == Method::POST;
                let response = handle_scheduler(
                    request(method.clone(), &supplied),
                    &options(enabled),
                    |deadline| async move {
                        assert!(
                            enabled && authorized && method_ok,
                            "rejected request reached dispatch"
                        );
                        let remaining = deadline - chrono::Utc::now().timestamp_millis();
                        assert!((19_000..=20_000).contains(&remaining));
                        Ok(DispatchReport {
                            enabled: true,
                            executed: 1,
                            ..Default::default()
                        })
                    },
                )
                .await;
                assert_eq!(
                    response.status(),
                    if !method_ok {
                        StatusCode::METHOD_NOT_ALLOWED
                    } else if !authorized {
                        StatusCode::UNAUTHORIZED
                    } else {
                        StatusCode::OK
                    }
                );
                assert_eq!(response.headers()["cache-control"], "no-store");
                if authorized && method_ok {
                    assert_eq!(
                        body(response).await,
                        json!({"enabled":enabled,"events":0,"scheduled":0,"executed":usize::from(enabled)})
                    );
                } else {
                    assert!(
                        to_bytes(response.into_body(), 1000)
                            .await
                            .unwrap()
                            .is_empty()
                    );
                }
            }
        }
    }
    for secret in ["".to_string(), "a".repeat(31), "é".repeat(31)] {
        let mut settings = options(true);
        settings
            .environment
            .insert("CRON_SECRET".into(), secret.clone());
        let response = handle_scheduler(request(Method::POST, &secret), &settings, |_| async {
            panic!("short secret reached dispatch");
        })
        .await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let mut duplicate = request(Method::POST, SECRET);
    duplicate
        .headers_mut()
        .append("authorization", SECRET.parse().unwrap());
    let response = handle_scheduler(duplicate, &options(true), |_| async {
        panic!("duplicate credentials reached dispatch")
    })
    .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    for enabled in [false, true] {
        let response =
            forge_server::router_with_state(AppState::default().with_loops(options(enabled)))
                .oneshot(request(Method::POST, SECRET))
                .await
                .unwrap();
        assert_eq!(
            response.status(),
            if enabled {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::OK
            }
        );
        assert_eq!(
            body(response).await,
            if enabled {
                json!({"code":"LOOP_DISPATCH_FAILED"})
            } else {
                json!({"enabled":false,"events":0,"scheduled":0,"executed":0})
            }
        );
    }
}

#[tokio::test]
async fn scheduler_waits_for_worker_settlement_and_redacts_failure_details() {
    let release = tokio::sync::Notify::new();
    let settings = options(true);
    let response = handle_scheduler(request(Method::GET, SECRET), &settings, |_| async {
        release.notified().await;
        Ok(DispatchReport {
            enabled: true,
            executed: 1,
            ..Default::default()
        })
    });
    tokio::pin!(response);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(10), &mut response)
            .await
            .is_err()
    );
    release.notify_one();
    assert_eq!(body(response.await).await["executed"], 1);
    let response = handle_scheduler(request(Method::POST, SECRET), &settings, |_| async {
        Err(StoreError::LoopPolicy(
            "private-provider-message-and-credentials",
        ))
    })
    .await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body(response).await, json!({"code":"LOOP_DISPATCH_FAILED"}));
}

#[test]
fn loop_operator_requires_a_known_command_and_explicit_target_but_feature_off_is_inert() {
    for args in [vec![], vec!["run", "unknown"], vec!["--watch"]] {
        let output = command().args(args).output().unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stderr).unwrap(),
            json!({"code":"INVALID_COMMAND"})
        );
    }
    for args in [vec!["run"], vec!["run", "--watch"]] {
        let output = command()
            .args(args)
            .env("FORGE_LOOPS_ENABLED", "false")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap(),
            json!({"job":"loops.dispatch","enabled":false,"events":0,"scheduled":0,"executed":0})
        );
    }
    let output = command()
        .arg("run")
        .env("FORGE_LOOPS_ENABLED", "true")
        .env("DATABASE_URL", "postgres://private-password@localhost")
        .env("FORGE_ENVIRONMENT", "development")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stderr).unwrap(),
        json!({"code":"INVALID_CONFIGURATION"})
    );
}

#[tokio::test]
async fn http_and_operator_ticks_settle_one_queued_run_and_reconcile_expiry_in_an_isolated_database()
 {
    let connection = std::env::var("FORGE_RUST_LOOPS_TEST_DATABASE_URL")
        .expect("Run the disposable milestone gate");
    let config: sqlx::postgres::PgConnectOptions = connection.parse().unwrap();
    assert_eq!(config.get_host(), "127.0.0.1");
    assert_eq!(config.get_database(), Some("forge_rust_loops"));
    assert_eq!(config.get_username(), "forge_rust_test");
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect_with(config)
        .await
        .unwrap();
    let database = Database::new(pool.clone());
    let workspace = Uuid::new_v4().to_string();
    let user = Uuid::new_v4().to_string();
    let session = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO organization(id,name,slug) VALUES($1,'Scheduler fixture',$1)")
        .bind(&workspace)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,email_verified) VALUES($1,'Scheduler owner',$2,true)",
    )
    .bind(&user)
    .bind(format!("{user}@example.test"))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')")
        .bind(Uuid::new_v4().to_string())
        .bind(&workspace)
        .bind(&user)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO session(id,token,user_id,active_organization_id,expires_at) VALUES($1,$1,$2,$3,clock_timestamp()+interval '1 day')").bind(&session).bind(&user).bind(&workspace).execute(&pool).await.unwrap();
    let actor = forge_store::authority::session_actor(&database, &session)
        .await
        .unwrap();
    let team = forge_store::teams::create(
        &database,
        &actor,
        &forge_core::teams::CreateTeam::parse(json!({
            "name":"Scheduled team","identifier":"SCH","timezone":"UTC",
            "icon":{"kind":"icon","value":"File01Icon","color":"#818cf8"}
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    let service = Service::new(database.clone(), options(true));
    let id = Uuid::new_v4();
    let fields = json!({"name":"Private loop name","description":"","instructions":"private-loop-instructions",
        "trigger":{"kind":"event","entity":"issue","event":"created"},"conditions":[],"reasoning":"auto","teamAccess":"this-team"});
    service
        .command(
            &actor,
            &team.id.to_string(),
            &Uuid::new_v4().to_string(),
            json!({"action":"create","id":id,"fields":fields}),
        )
        .await
        .unwrap();
    service
        .command(
            &actor,
            &team.id.to_string(),
            &Uuid::new_v4().to_string(),
            json!({"action":"enable","id":id,"expectedRevision":1}),
        )
        .await
        .unwrap();
    let mut runs = vec![];
    for event in [
        json!({"kind":"manual","entity":"issue","entityId":Uuid::new_v4()}),
        json!({"kind":"manual"}),
        json!({"kind":"manual"}),
    ] {
        let run = Uuid::new_v4();
        sqlx::query("INSERT INTO loop_runs(id,workspace_id,loop_id,loop_revision,event_key,event_hash,event,fields,authorizer_id) VALUES($1,$2,$3,2,$1::text,$4,$5,$6,$7)")
            .bind(run).bind(&workspace).bind(id).bind(forge_core::canonical::command_input_hash(&event)).bind(event).bind(&fields).bind(&user).execute(&pool).await.unwrap();
        runs.push(run);
    }
    sqlx::query("UPDATE loop_runs SET state='waiting-for-approval',started_at=clock_timestamp()-interval '6 minutes' WHERE id=$1")
        .bind(runs[2]).execute(&pool).await.unwrap();
    let app = forge_server::router_with_state(
        AppState::configured_database(
            database,
            AuthSettings::new(
                "fixture-auth-secret-with-32-characters".into(),
                "http://localhost:3100",
            )
            .unwrap(),
            None,
        )
        .with_loops(options(true)),
    );
    let response = app
        .clone()
        .oneshot(request(Method::POST, "wrong"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let waiting: String = sqlx::query_scalar("SELECT state FROM loop_runs WHERE id=$1")
        .bind(runs[2])
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(waiting, "waiting-for-approval");
    let response = app.oneshot(request(Method::GET, SECRET)).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        body(response).await,
        json!({"enabled":true,"events":0,"scheduled":0,"executed":1})
    );
    let states: Vec<String> = sqlx::query_scalar(
        "SELECT state FROM loop_runs WHERE workspace_id=$1 ORDER BY created_at,id",
    )
    .bind(&workspace)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(states, ["blocked", "queued", "failed"]);
    let output = command()
        .args(["run"])
        .env("FORGE_LOOPS_ENABLED", "true")
        .env("FORGE_ENVIRONMENT", "development")
        .env("DATABASE_URL", &connection)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"job":"loops.dispatch","enabled":true,"events":0,"scheduled":0,"executed":1})
    );
    let state: (String, String) =
        sqlx::query_as("SELECT state,error_code FROM loop_runs WHERE id=$1")
            .bind(runs[1])
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(state, ("failed".into(), "EXECUTION_FAILED".into()));
    #[cfg(unix)]
    {
        use std::{process::Stdio, time::Duration};
        use tokio::io::AsyncBufReadExt;
        let mut configuration = command();
        configuration
            .args(["run", "--watch"])
            .env("FORGE_LOOPS_ENABLED", "true")
            .env("FORGE_ENVIRONMENT", "development")
            .env("DATABASE_URL", &connection)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut process = tokio::process::Command::from(configuration)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut lines = tokio::io::BufReader::new(process.stdout.take().unwrap()).lines();
        let first = tokio::time::timeout(Duration::from_secs(15), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&first).unwrap(),
            json!({"job":"loops.dispatch","enabled":true,"events":0,"scheduled":0,"executed":0})
        );
        assert!(
            Command::new("/bin/kill")
                .args(["-TERM", &process.id().unwrap().to_string()])
                .status()
                .unwrap()
                .success()
        );
        let output = tokio::time::timeout(Duration::from_secs(5), process.wait_with_output())
            .await
            .unwrap()
            .unwrap();
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
    }
    pool.close().await;
}
