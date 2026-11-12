use super::*;
use chrono::{Duration, Utc};
use serde_json::json;
#[tokio::test]
async fn call_retention_requires_independent_preparation_and_keeps_committed_redaction_on_publication_failure()
 {
    let f = Fixture::new().await;
    forge_store::workspaces::create(
        &f.database,
        &f.token,
        "Call retention recovery",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &f.token)
        .await
        .unwrap();
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Recovery calls","identifier":"REC","timezone":"UTC","icon":{"kind":"icon","value":"File01Icon","color":"#818cf8"}})).unwrap()).await.unwrap();
    let service = forge_store::calls::Service::new(f.database.clone(), Default::default());
    let call=service.import(&actor,json!({"teamId":team.id,"title":"Private call","startedAt":forge_core::loops::iso_timestamp(Utc::now()-Duration::days(20)),"text":"Alex: private-transcript-content","consentConfirmed":true})).await.unwrap();
    f.backend.mode.store(1, Ordering::SeqCst);
    assert!(matches!(
        service.save_retention(&actor, json!({"days":7})).await,
        Err(StoreError::Recovery(_))
    ));
    let state: (String, serde_json::Value) =
        sqlx::query_as("SELECT status,transcript FROM calls WHERE id=$1")
            .bind(call)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(state.0, "ready");
    assert_eq!(state.1[0]["text"], "private-transcript-content");
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM call_settings WHERE workspace_id=$1")
        .bind(&actor.workspace_id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    f.backend.mode.store(2, Ordering::SeqCst);
    assert!(matches!(
        service.save_retention(&actor, json!({"days":7})).await,
        Err(StoreError::Recovery(_))
    ));
    let state: (String, serde_json::Value) =
        sqlx::query_as("SELECT status,transcript FROM calls WHERE id=$1")
            .bind(call)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(state, ("expired".into(), json!([])));
    let records:Vec<serde_json::Value>=sqlx::query_scalar("SELECT jsonb_build_object('table',e.table_name,'action',e.action,'patch',e.patch,'published',o.published_at IS NOT NULL) FROM recovery_events e JOIN recovery_operations o ON o.id=e.operation_id WHERE (e.table_name='call_settings' AND e.row_key->>'workspace_id'=$1) OR (e.table_name='calls' AND e.row_key->>'id'=$2) ORDER BY e.sequence")
        .bind(&actor.workspace_id).bind(call.to_string()).fetch_all(&f.pool).await.unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(
        records[0],
        json!({"table":"call_settings","action":"upsert","patch":{"retention_days":7},"published":false})
    );
    assert_eq!(
        records[1],
        json!({"table":"calls","action":"patch","patch":{"status":"expired","transcript":[]},"published":false})
    );
    assert!(
        !json!(records)
            .to_string()
            .contains("private-transcript-content")
    );
    f.backend.mode.store(0, Ordering::SeqCst);
    assert_eq!(service.sweep(Some(&actor.workspace_id)).await.unwrap(), 0);
    assert_eq!(
        service.read(&actor, json!({"callId":call})).await.unwrap()["transcript"],
        json!([])
    );
}
