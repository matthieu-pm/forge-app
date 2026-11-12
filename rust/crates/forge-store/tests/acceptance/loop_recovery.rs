use super::*;
use serde_json::json;
#[tokio::test]
async fn loop_commands_and_webhook_receipts_require_independent_preparation() {
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Loop recovery",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Loops","identifier":"LOP","icon":{"kind":"icon","value":"File01Icon","color":"#818cf8"},"timezone":"UTC"})).unwrap()).await.unwrap();
    let service = forge_store::loops::Service::new(
        f.database.clone(),
        forge_store::loops::Options::from_environment(std::collections::HashMap::from([
            ("NODE_ENV".into(), "test".into()),
            ("FORGE_LOOPS_ENABLED".into(), "true".into()),
            ("AGENT_FAKE_RUNTIME_ENABLED".into(), "true".into()),
            (
                "FORGE_LOOP_WEBHOOK_SECRET".into(),
                "loop-recovery-fixture-secret-at-least-32".into(),
            ),
        ])),
    );
    let id = Uuid::new_v4();
    let key = Uuid::new_v4().to_string();
    let input = json!({"action":"create","id":id,"fields":{"name":"Recovery","description":"","instructions":"Handle event","trigger":{"kind":"webhook"},"conditions":[],"reasoning":"auto","teamAccess":"this-team"}});
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(matches!(
        service
            .command(&actor, &team.id.to_string(), &key, input.clone())
            .await,
        Err(StoreError::Recovery(_))
    ));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM team_loops WHERE id=$1")
        .bind(id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    f.backend.mode.store(0, Ordering::SeqCst);
    service
        .command(&actor, &team.id.to_string(), &key, input.clone())
        .await
        .unwrap();
    service
        .command(&actor, &team.id.to_string(), &key, input)
        .await
        .unwrap();
    let secret = service
        .command(
            &actor,
            &team.id.to_string(),
            &Uuid::new_v4().to_string(),
            json!({"action":"rotate-webhook","id":id,"expectedRevision":1}),
        )
        .await
        .unwrap();
    let mut policy = f.database.begin().await.unwrap();
    policy.prepare().await.unwrap();
    sqlx::query("INSERT INTO workspace_security_settings(workspace_id,external_loop_sources_enabled) VALUES($1,true) ON CONFLICT(workspace_id) DO UPDATE SET external_loop_sources_enabled=true").bind(&actor.workspace_id).execute(&mut *policy).await.unwrap();
    policy.commit().await.unwrap();
    service
        .command(
            &actor,
            &team.id.to_string(),
            &Uuid::new_v4().to_string(),
            json!({"action":"enable","id":id,"expectedRevision":2}),
        )
        .await
        .unwrap();
    let token = secret["webhookSecret"].as_str().unwrap();
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(matches!(
        service
            .webhook(&id.to_string(), token, "recovery-event", json!({"event":1}))
            .await,
        Err(StoreError::Recovery(_))
    ));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM loop_runs WHERE loop_id=$1")
        .bind(id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    f.backend.mode.store(0, Ordering::SeqCst);
    let first = service
        .webhook(&id.to_string(), token, "recovery-event", json!({"event":1}))
        .await
        .unwrap();
    assert_eq!(
        service
            .webhook(&id.to_string(), token, "recovery-event", json!({"event":1}))
            .await
            .unwrap(),
        first
    );
}
