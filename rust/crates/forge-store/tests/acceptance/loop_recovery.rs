use super::agent_blobs as loop_blobs;
use super::*;
use serde_json::json;

#[tokio::test]
async fn loop_artifact_reservation_and_publication_preserve_independent_recovery_failures() {
    use forge_core::actor::{Actor, Authentication};
    let (f, actor, team, loops) = setup().await;
    let definition = Uuid::new_v4();
    let fields = json!({"name":"Recovery upload","description":"","instructions":"Handle event","trigger":{"kind":"event","entity":"issue","event":"created"},"conditions":[],"reasoning":"auto","teamAccess":"this-team"});
    loops
        .command(
            &actor,
            &team.id.to_string(),
            &Uuid::new_v4().to_string(),
            json!({"action":"create","id":definition,"fields":fields}),
        )
        .await
        .unwrap();
    loops
        .command(
            &actor,
            &team.id.to_string(),
            &Uuid::new_v4().to_string(),
            json!({"action":"enable","id":definition,"expectedRevision":1}),
        )
        .await
        .unwrap();
    let mut tx = f.database.begin().await.unwrap();
    tx.prepare().await.unwrap();
    let (run,thread,agent_run):(Uuid,Uuid,Uuid)=sqlx::query_as("INSERT INTO loop_runs(workspace_id,loop_id,loop_revision,event_key,event_hash,event,fields,authorizer_id,state,started_at) SELECT workspace_id,id,revision,$2,$2,'{\"kind\":\"manual\"}',fields,$3,'running',clock_timestamp() FROM team_loops WHERE id=$1 RETURNING id,thread_id,agent_run_id").bind(definition).bind(Uuid::new_v4().to_string()).bind(&actor.user_id).fetch_one(&mut *tx).await.unwrap();
    let principal = forge_core::loops::principal_id(&definition.to_string());
    sqlx::query("INSERT INTO agent_threads(id,workspace_id,created_by_user_id) VALUES($1,$2,$3)")
        .bind(thread)
        .bind(&actor.workspace_id)
        .bind(&principal)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,state,execution_kind,requested_selection) VALUES($1,$2,$3,'running','forge-native',$4)").bind(agent_run).bind(thread).bind(&principal).bind(json!({"loopRunId":run})).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let loop_actor = Actor {
        user_id: principal,
        authentication: Authentication::Loop {
            loop_id: definition.to_string(),
            run_id: run.to_string(),
        },
        ..actor
    };
    let blobs = Arc::new(loop_blobs::Memory::default());
    let files = forge_store::agents::files::Service::new(f.database.clone(), blobs.clone());
    let input = json!({"name":"loop.txt","contentType":"text/plain","content":"Private loop recovery bytes"});
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(matches!(
        files
            .create_artifact(&loop_actor, agent_run, input.clone())
            .await,
        Err(StoreError::Recovery(_))
    ));
    assert!(blobs.values.lock().unwrap().is_empty());
    let intents: i64 =
        sqlx::query_scalar("SELECT count(*) FROM loop_artifact_intents WHERE agent_run_id=$1")
            .bind(agent_run)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(intents, 0);
    f.backend.mode.store(0, Ordering::SeqCst);
    blobs.pause_put.store(true, Ordering::SeqCst);
    let upload = files.create_artifact(&loop_actor, agent_run, input.clone());
    let fail_publication = async {
        blobs.entered.notified().await;
        let intents: i64 =
            sqlx::query_scalar("SELECT count(*) FROM loop_artifact_intents WHERE agent_run_id=$1")
                .bind(agent_run)
                .fetch_one(&f.pool)
                .await
                .unwrap();
        assert_eq!(intents, 1);
        f.backend.mode.store(2, Ordering::SeqCst);
        blobs.resume.notify_one();
    };
    let (result, ()) = tokio::join!(upload, fail_publication);
    assert!(matches!(result, Err(StoreError::Recovery(_))));
    let counts:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM loop_artifact_intents WHERE agent_run_id=$1),(SELECT count(*) FROM agent_artifacts WHERE run_id=$1),(SELECT count(*) FROM agent_events WHERE run_id=$1 AND type='artifact.created')").bind(agent_run).fetch_one(&f.pool).await.unwrap();
    assert_eq!(counts, (0, 1, 1));
    assert_eq!(blobs.values.lock().unwrap().len(), 1);
    f.backend.mode.store(0, Ordering::SeqCst);
    let saved = files
        .create_artifact(&loop_actor, agent_run, input)
        .await
        .unwrap();
    assert_eq!(
        files
            .read_artifact(&loop_actor, saved["id"].as_str().unwrap().parse().unwrap())
            .await
            .unwrap()
            .1,
        b"Private loop recovery bytes"
    );
    assert_eq!(blobs.values.lock().unwrap().len(), 1);
}
async fn setup() -> (
    Fixture,
    forge_core::actor::Actor,
    forge_core::teams::TeamSummary,
    forge_store::loops::Service,
) {
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
    (f, actor, team, service)
}
#[tokio::test]
async fn loop_commands_and_webhook_receipts_require_independent_preparation() {
    let (f, actor, team, service) = setup().await;
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

#[tokio::test]
async fn loop_scanners_and_expiry_prepare_before_captures_acknowledgements_or_state_changes() {
    let (f, actor, team, mut service) = setup().await;
    let now: chrono::DateTime<chrono::Utc> = "2030-01-01T00:00:00Z".parse().unwrap();
    service.now = Arc::new(move || now);
    let native = Uuid::new_v4();
    let scheduled = Uuid::new_v4();
    for (id, trigger) in [
        (
            native,
            json!({"kind":"event","entity":"project","event":"created"}),
        ),
        (
            scheduled,
            json!({"kind":"schedule","unit":"hours","interval":1,"startAt":"2030-01-01T01:00:00Z","timeZone":"UTC"}),
        ),
    ] {
        service.command(&actor,&team.id.to_string(),&Uuid::new_v4().to_string(),json!({"action":"create","id":id,"fields":{"name":"Scanner recovery","description":"","instructions":"Handle event","trigger":trigger,"conditions":[],"reasoning":"auto","teamAccess":"this-team"}})).await.unwrap();
        service
            .command(
                &actor,
                &team.id.to_string(),
                &Uuid::new_v4().to_string(),
                json!({"action":"enable","id":id,"expectedRevision":1}),
            )
            .await
            .unwrap();
    }
    let event = Uuid::new_v4();
    let mut tx = f.database.begin().await.unwrap();
    tx.prepare().await.unwrap();
    sqlx::query("INSERT INTO loop_events(id,workspace_id,team_id,entity,entity_id,event,after,created_at) VALUES($1,$2,$3,'project',$4,'created',$5,$6)")
        .bind(event).bind(&actor.workspace_id).bind(team.id).bind(Uuid::new_v4()).bind(json!({"name":"Captured project","teamIds":[team.id]})).bind(now).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    let due = now + chrono::Duration::hours(2);
    let completed = f.backend.completed.lock().unwrap().len();
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(matches!(
        service.enqueue_native(10, Some(&actor.workspace_id)).await,
        Err(StoreError::Recovery(_))
    ));
    assert!(matches!(
        service
            .enqueue_scheduled(due, Some(&actor.workspace_id))
            .await,
        Err(StoreError::Recovery(_))
    ));
    let snapshot:(bool,i64,chrono::DateTime<chrono::Utc>)=sqlx::query_as("SELECT (SELECT processed_at IS NULL FROM loop_events WHERE id=$1),(SELECT count(*) FROM loop_runs WHERE workspace_id=$2),(SELECT next_run_at FROM team_loops WHERE id=$3)")
        .bind(event).bind(&actor.workspace_id).bind(scheduled).fetch_one(&f.pool).await.unwrap();
    assert_eq!(snapshot, (true, 0, now + chrono::Duration::hours(1)));
    assert_eq!(f.backend.completed.lock().unwrap().len(), completed);
    f.backend.mode.store(0, Ordering::SeqCst);
    assert_eq!(
        service
            .enqueue_native(10, Some(&actor.workspace_id))
            .await
            .unwrap(),
        1
    );
    assert_eq!(f.backend.completed.lock().unwrap().len(), completed + 1);
    assert_eq!(
        service
            .enqueue_scheduled(due, Some(&actor.workspace_id))
            .await
            .unwrap(),
        1
    );
    assert_eq!(f.backend.completed.lock().unwrap().len(), completed + 2);
    assert_eq!(
        service
            .enqueue_native(10, Some(&actor.workspace_id))
            .await
            .unwrap(),
        0
    );
    assert_eq!(f.backend.completed.lock().unwrap().len(), completed + 2);
    assert_eq!(
        service
            .enqueue_scheduled(due, Some(&actor.workspace_id))
            .await
            .unwrap(),
        0
    );
    let mut tx = f.database.begin().await.unwrap();
    tx.prepare().await.unwrap();
    sqlx::query("UPDATE loop_runs SET state='waiting-for-approval',started_at=$1 WHERE loop_id=$2")
        .bind(now)
        .bind(native)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(matches!(
        service.expire_runs(due, Some(&actor.workspace_id)).await,
        Err(StoreError::Recovery(_))
    ));
    let state: String = sqlx::query_scalar("SELECT state FROM loop_runs WHERE loop_id=$1")
        .bind(native)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(state, "waiting-for-approval");
    assert_eq!(f.backend.completed.lock().unwrap().len(), completed + 3);
    f.backend.mode.store(0, Ordering::SeqCst);
    assert_eq!(
        service
            .expire_runs(due, Some(&actor.workspace_id))
            .await
            .unwrap()
            .approvals,
        1
    );
    // The deletion journal intentionally omits ordinary inserts and queue
    // progress. Its preparation/publication handshake must still complete.
    let operations: Vec<Uuid> = {
        let batches = f.backend.completed.lock().unwrap();
        assert_eq!(batches.len(), completed + 4);
        batches[completed..]
            .iter()
            .map(|(id, _)| id.parse().unwrap())
            .collect()
    };
    let published: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM recovery_operations WHERE id=ANY($1) AND published_at IS NOT NULL",
    )
    .bind(&operations)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(published, 4);
    let (state, code, runs): (String, String, i64) = sqlx::query_as("SELECT state,error_code,(SELECT count(*) FROM loop_runs WHERE workspace_id=$2) FROM loop_runs WHERE loop_id=$1")
        .bind(native).bind(&actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(
        (state.as_str(), code.as_str(), runs),
        ("failed", "RUN_WALL_CLOCK_LIMIT", 2)
    );
}
