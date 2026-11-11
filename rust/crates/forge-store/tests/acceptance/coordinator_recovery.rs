use super::*;
use forge_store::agents::{
    RunState,
    coordinator::{CODEX_LOCAL_CONNECTION_ID, Service},
    runs,
};
use serde_json::json;
#[tokio::test]
async fn coordinator_commits_related_rows_together_and_retries_do_not_double_charge_after_archive_failure()
 {
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Coordinator recovery",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let service = Service::new(f.database.clone());
    let thread = service.create_thread(&actor, json!({})).await.unwrap();
    let input = json!({"threadId":thread.id,"runtimeId":"codex","message":"Local recovery","model":{"selectionId":"local:codex:gpt-codex","connectionId":CODEX_LOCAL_CONNECTION_ID,"executionKind":"external-agent","provider":"openai","modelId":"gpt-codex"}});
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(service.prepare_local(&actor, input.clone()).await.is_err());
    assert!(
        service
            .thread_events(&actor, thread.id)
            .await
            .unwrap()
            .is_empty()
    );
    f.backend.mode.store(0, Ordering::SeqCst);
    let completed_before = f.backend.completed.lock().unwrap().len();
    let prepared = service.prepare_local(&actor, input).await.unwrap();
    {
        let completed = f.backend.completed.lock().unwrap();
        // Creation commits one prepared operation. The deletion journal only
        // captures destructive transitions, so creation does not copy chat data.
        assert_eq!(completed.len(), completed_before + 1);
        assert!(completed.last().unwrap().1.is_empty());
    }
    let usage = json!([{"sourceEventId":"usage-archive-fixture","source":"codex","type":"run.usage","occurredAt":"2026-11-11T00:00:00Z","payload":{"costMicros":20,"inputTokens":7}}]);
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(
        service
            .ingest_local(&actor, prepared.run.id, usage.clone())
            .await
            .is_err()
    );
    assert_eq!(
        service
            .run_events(&actor, prepared.run.id, 0)
            .await
            .unwrap()
            .len(),
        3
    );
    f.backend.mode.store(2, Ordering::SeqCst);
    assert!(
        service
            .ingest_local(&actor, prepared.run.id, usage.clone())
            .await
            .is_err()
    );
    let run = runs::get(&f.database, &actor.workspace_id, prepared.run.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.cost_micros, 20);
    assert_eq!(run.input_tokens, 7);
    f.backend.mode.store(0, Ordering::SeqCst);
    service
        .ingest_local(&actor, prepared.run.id, usage)
        .await
        .unwrap();
    let run = runs::get(&f.database, &actor.workspace_id, prepared.run.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.cost_micros, 20);
    assert_eq!(
        service
            .run_events(&actor, prepared.run.id, 0)
            .await
            .unwrap()
            .len(),
        4
    );
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(service.cancel_local(&actor, prepared.run.id).await.is_err());
    assert_eq!(
        runs::get(&f.database, &actor.workspace_id, prepared.run.id)
            .await
            .unwrap()
            .unwrap()
            .state,
        RunState::Running
    );
    f.backend.mode.store(0, Ordering::SeqCst);
    service.cancel_local(&actor, prepared.run.id).await.unwrap();
    let completed = f.backend.completed.lock().unwrap();
    assert!(
        completed
            .last()
            .unwrap()
            .1
            .iter()
            .any(|e| e.table == "agent_runs"
                && e.key["id"] == prepared.run.id.to_string()
                && e.patch.as_ref().is_some_and(|p| p["state"] == "cancelled"))
    );
}
