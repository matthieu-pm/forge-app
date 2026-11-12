use super::*;
use chrono::{DateTime, Duration, Utc};
use forge_store::calls::{Options, Service};
use std::{collections::HashMap, sync::Arc};
fn service(f: &Fixture) -> Service {
    Service::new(f.database.clone(), Options::default())
}
fn imported(team: Uuid, time: DateTime<Utc>, text: &str) -> Value {
    json!({"teamId":team,"title":"  Team review  ","startedAt":forge_core::loops::iso_timestamp(time),"text":text,"consentConfirmed":true})
}
async fn call(s: &Service, a: &Actor, team: Uuid) -> Uuid {
    s.import(a, imported(team, Utc::now(), "WEBVTT\n\n00:00:12.400 --> 00:00:15.000\n<v Alex>Decision: start small.</v>\n\n2\n00:01:01,000 --> 00:01:05,000\nSam: Prepare pilot.")).await.unwrap()
}
#[tokio::test]
async fn calls_import_preserves_native_transcripts_and_lists_only_lightweight_projections() {
    let f = Fixture::new().await;
    let mut s = service(&f);
    s.options.environment = HashMap::from([
        ("FORGE_GOOGLE_MEET_CLIENT_ID".into(), "private-id".into()),
        (
            "FORGE_GOOGLE_MEET_CLIENT_SECRET".into(),
            "private-secret".into(),
        ),
        ("FORGE_MODEL_CREDENTIAL_KEK".into(), "private-key".into()),
        ("BETTER_AUTH_URL".into(), "https://example.test".into()),
    ]);
    let team = issue_acceptance::team(&f, 130).await;
    let id = call(&s, &f.actor, team).await;
    let full = s.read(&f.actor, json!({"callId":id})).await.unwrap();
    assert_eq!(full["title"], "Team review");
    assert_eq!(full["provider"], "upload");
    assert_eq!(full["duration"], 2);
    assert_eq!(full["participants"], json!(["Alex", "Sam"]));
    assert_eq!(full["status"], "ready");
    assert_eq!(full["summaryStatus"], "pending");
    assert_eq!(
        full["transcript"][0],
        json!({"speaker":"Alex","seconds":12,"text":"Decision: start small."})
    );
    let list = s.list(&f.actor, json!({})).await.unwrap();
    assert_eq!(list["calls"][0]["id"], id.to_string());
    assert_eq!(list["calls"][0]["transcript"], json!([]));
    assert_eq!(list["configuredProviders"], json!(["google"]));
    assert_eq!(list["retentionDays"], 30);
    assert!(!list.to_string().contains("private-"));
    for text in ["WEBVTT\n\n".into(), format!("Alex: {}", "🙂".repeat(10001))] {
        assert!(matches!(
            s.import(&f.actor, imported(team, Utc::now(), &text)).await,
            Err(StoreError::Call(_))
        ));
    }
    let mut denied = imported(team, Utc::now(), "Alex: Hi");
    denied["consentConfirmed"] = json!(false);
    assert!(matches!(
        s.import(&f.actor, denied).await,
        Err(StoreError::InvalidInput)
    ));
    assert_eq!(
        s.list(&f.actor, json!({})).await.unwrap()["calls"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn calls_require_current_membership_and_private_team_visibility_for_reads_and_mutations() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let guest = enter_workspace(&f, &visitor).await;
    let s = service(&f);
    let public = issue_acceptance::team(&f, 131).await;
    let private = issue_acceptance::team(&f, 132).await;
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(private)
        .execute(&f.pool)
        .await
        .unwrap();
    let visible = call(&s, &f.actor, public).await;
    let hidden = call(&s, &f.actor, private).await;
    let list = s.list(&guest, json!({})).await.unwrap();
    assert_eq!(list["canManage"], false);
    assert_eq!(list["calls"].as_array().unwrap().len(), 1);
    assert_eq!(list["calls"][0]["id"], visible.to_string());
    assert!(matches!(
        s.list(&guest, json!({"teamId":private})).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        s.read(&guest, json!({"callId":hidden})).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        s.add_note(&guest, json!({"callId":hidden,"body":"No","kind":"note"}))
            .await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        s.read(&visitor.actor, json!({"callId":visible})).await,
        Err(StoreError::Forbidden)
    ));
    // enter_workspace changed the visitor's active session. Use an independent
    // current session to reach the cross-workspace lookup, not its stale actor.
    let unrelated = Fixture::new().await;
    assert!(matches!(
        s.read(&unrelated.actor, json!({"callId":visible})).await,
        Err(StoreError::NotFound)
    ));
    sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
        .bind(&guest.workspace_id)
        .bind(&guest.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        s.read(&guest, json!({"callId":visible})).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        s.import(&guest, imported(public, Utc::now(), "Alex: Hello"))
            .await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn call_notes_actions_and_connection_metadata_keep_their_exact_call_and_workspace_binding() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let s = service(&f);
    let team = issue_acceptance::team(&f, 133).await;
    let second_team = issue_acceptance::team(&f, 134).await;
    let first = call(&s, &f.actor, team).await;
    let second = call(&s, &f.actor, team).await;
    let action = Uuid::new_v4();
    sqlx::query("INSERT INTO call_actions(id,call_id,title,owner) VALUES($1,$2,'Prepare','Sam')")
        .bind(action)
        .bind(first)
        .execute(&f.pool)
        .await
        .unwrap();
    s.set_action(
        &f.actor,
        json!({"callId":second,"actionId":action,"completed":true}),
    )
    .await
    .unwrap();
    assert_eq!(
        s.read(&f.actor, json!({"callId":first})).await.unwrap()["actions"][0]["completed"],
        false
    );
    s.set_action(
        &f.actor,
        json!({"callId":first,"actionId":action,"completed":true}),
    )
    .await
    .unwrap();
    s.add_note(
        &f.actor,
        json!({"callId":first,"body":"  Follow up  ","kind":"follow-up"}),
    )
    .await
    .unwrap();
    let full = s.read(&f.actor, json!({"callId":first})).await.unwrap();
    assert_eq!(
        full["actions"][0],
        json!({"id":action,"title":"Prepare","owner":"Sam","completed":true})
    );
    assert_eq!(full["notes"][0]["body"], "Follow up");
    assert_eq!(full["notes"][0]["author"], "Original Actor");
    let connection = Uuid::new_v4();
    sqlx::query("INSERT INTO call_connections(id,workspace_id,user_id,team_id,provider,secret,oauth_verifier,oauth_state_hash,last_synced_at) VALUES($1,$2,$3,$4,'google','private-credential','private-verifier','private-state',clock_timestamp())")
        .bind(connection).bind(&f.actor.workspace_id).bind(&f.actor.user_id).bind(second_team).execute(&f.pool).await.unwrap();
    let list = s.list(&f.actor, json!({"teamId":team})).await.unwrap();
    assert_eq!(list["connections"][0]["id"], connection.to_string());
    assert_eq!(list["connections"][0]["connected"], true);
    assert_eq!(list["connections"][0]["isOwner"], true);
    assert!(!list.to_string().contains("private-"));
    assert!(
        list["connections"][0]["lastSyncedAt"]
            .as_str()
            .unwrap()
            .ends_with('Z')
    );
    s.disconnect(&other.actor, json!({"id":connection}))
        .await
        .unwrap();
    assert_eq!(
        s.list(&f.actor, json!({})).await.unwrap()["connections"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    s.disconnect(&f.actor, json!({"id":connection}))
        .await
        .unwrap();
    assert_eq!(
        s.list(&f.actor, json!({})).await.unwrap()["connections"],
        json!([])
    );
}

#[tokio::test]
async fn retention_redacts_only_expired_transcripts_preserves_derived_content_and_serializes_imports()
 {
    let f = Fixture::new().await;
    let mut s = service(&f);
    let now = DateTime::from_timestamp_millis(Utc::now().timestamp_millis()).unwrap();
    s.now = Arc::new(move || now);
    let team = issue_acceptance::team(&f, 135).await;
    let boundary = s
        .import(
            &f.actor,
            imported(team, now - Duration::days(30), "Alex: Boundary"),
        )
        .await
        .unwrap();
    assert!(matches!(
        s.import(
            &f.actor,
            imported(
                team,
                now - Duration::days(30) - Duration::milliseconds(1),
                "Alex: Old"
            )
        )
        .await,
        Err(StoreError::Call(_))
    ));
    s.import(
        &f.actor,
        imported(team, now + Duration::days(1), "Alex: Next day"),
    )
    .await
    .unwrap();
    assert!(matches!(
        s.import(
            &f.actor,
            imported(
                team,
                now + Duration::days(1) + Duration::milliseconds(1),
                "Alex: Future"
            )
        )
        .await,
        Err(StoreError::Call(_))
    ));
    let action = Uuid::new_v4();
    sqlx::query("UPDATE calls SET summary='Retained summary',decisions='[\"Retained decision\"]',summary_status='ready',summary_lease_at=clock_timestamp() WHERE id=$1").bind(boundary).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO call_actions(id,call_id,title) VALUES($1,$2,'Retained action')")
        .bind(action)
        .bind(boundary)
        .execute(&f.pool)
        .await
        .unwrap();
    s.add_note(
        &f.actor,
        json!({"callId":boundary,"body":"Retained note","kind":"note"}),
    )
    .await
    .unwrap();
    assert_eq!(s.sweep(Some(&f.actor.workspace_id)).await.unwrap(), 0);
    s.save_retention(&f.actor, json!({"days":7})).await.unwrap();
    let full = s.read(&f.actor, json!({"callId":boundary})).await.unwrap();
    assert_eq!(full["status"], "expired");
    assert_eq!(full["transcript"], json!([]));
    assert!(full["summaryLeaseAt"].is_null());
    assert_eq!(full["summary"], "Retained summary");
    assert_eq!(full["decisions"], json!(["Retained decision"]));
    assert_eq!(full["actions"][0]["id"], action.to_string());
    assert_eq!(full["notes"][0]["body"], "Retained note");
    s.save_retention(&f.actor, json!({"days":30}))
        .await
        .unwrap();
    assert_eq!(
        s.read(&f.actor, json!({"callId":boundary})).await.unwrap()["transcript"],
        json!([])
    );
    let (imported, changed) = tokio::join!(
        s.import(
            &f.actor,
            imported(team, now - Duration::days(10), "Sam: Race")
        ),
        s.save_retention(&f.actor, json!({"days":7}))
    );
    changed.unwrap();
    match imported {
        Ok(id) => assert_eq!(
            s.read(&f.actor, json!({"callId":id})).await.unwrap()["status"],
            "expired"
        ),
        Err(StoreError::Call(_)) => {}
        Err(error) => panic!("unexpected import outcome: {error}"),
    }
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        s.save_retention(&f.actor, json!({"days":365})).await,
        Err(StoreError::Forbidden)
    ));
    assert_eq!(
        s.list(&f.actor, json!({})).await.unwrap()["retentionDays"],
        7
    );
}

#[tokio::test]
async fn calls_obey_loop_team_scope_without_inheriting_human_membership_or_admin_privilege() {
    let f = Fixture::new().await;
    let s = service(&f);
    let own = issue_acceptance::team(&f, 136).await;
    let other = issue_acceptance::team(&f, 137).await;
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(own)
        .execute(&f.pool)
        .await
        .unwrap();
    let visible = call(&s, &f.actor, own).await;
    let hidden = call(&s, &f.actor, other).await;
    let claimed =
        loop_authority_acceptance::claimed(&f, own, json!({"kind":"manual"}), false).await;
    let result = s.list(&claimed.actor, json!({})).await.unwrap();
    assert_eq!(result["canManage"], false);
    assert_eq!(result["calls"].as_array().unwrap().len(), 1);
    assert_eq!(result["calls"][0]["id"], visible.to_string());
    assert!(matches!(
        s.read(&claimed.actor, json!({"callId":hidden})).await,
        Err(StoreError::Forbidden)
    ));
    assert!(matches!(
        s.save_retention(&claimed.actor, json!({"days":7})).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE team_loops SET enabled=false WHERE id=$1")
        .bind(claimed.definition)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        s.list(&claimed.actor, json!({})).await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn calls_directory_bounds_rows_and_hides_archived_teams_without_loading_transcripts() {
    let f = Fixture::new().await;
    let s = service(&f);
    let team = issue_acceptance::team(&f, 138).await;
    sqlx::query("INSERT INTO calls(workspace_id,team_id,provider,external_id,title,started_at,transcript,status) SELECT $1,$2,'upload',n::text,'Call '||n,clock_timestamp()-(n*interval '1 second'),'[{\"speaker\":\"Alex\",\"seconds\":0,\"text\":\"Private transcript\"}]','ready' FROM generate_series(1,101) n")
        .bind(&f.actor.workspace_id).bind(team).execute(&f.pool).await.unwrap();
    let result = s.list(&f.actor, json!({})).await.unwrap();
    assert_eq!(result["calls"].as_array().unwrap().len(), 100);
    assert_eq!(result["calls"][0]["title"], "Call 1");
    assert_eq!(result["calls"][99]["title"], "Call 100");
    assert!(!result.to_string().contains("Private transcript"));
    sqlx::query("UPDATE teams SET deleted_at=clock_timestamp() WHERE id=$1")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        s.list(&f.actor, json!({})).await.unwrap()["calls"],
        json!([])
    );
}
