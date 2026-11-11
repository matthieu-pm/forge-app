use super::{
    Fixture, enter_workspace,
    issue_acceptance::{create, team},
};
use forge_core::actor::{Actor, Authentication};
use forge_store::{
    StoreError,
    documents::{self, DocumentOptions},
    initiatives::InitiativeOptions,
    product_state as state, projects,
};
use serde_json::{Value, json};
use uuid::Uuid;
const OPTIONS: InitiativeOptions = InitiativeOptions { enabled: false };
fn input(a: &Actor, key: &str, value: Option<&str>, revision: i32) -> Value {
    json!({"workspaceId":a.workspace_id,"sessionId":match &a.authentication{Authentication::Session{session_id}=>session_id.as_str(),_=>"external"},"commandKey":Uuid::new_v4(),"key":key,"value":value,"expectedRevision":revision})
}
async fn save(
    f: &Fixture,
    a: &Actor,
    key: &str,
    value: Option<&str>,
    revision: i32,
) -> Result<Value, StoreError> {
    state::save(&f.database, a, input(a, key, value, revision), OPTIONS).await
}
async fn snapshot(f: &Fixture, a: &Actor) -> Value {
    state::read(&f.database, a, OPTIONS).await.unwrap()
}
async fn entry(f: &Fixture, a: &Actor, key: &str) -> Option<Value> {
    snapshot(f, a).await["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["key"] == key)
        .cloned()
}
async fn raw(f: &Fixture, a: &Actor, key: &str) -> Option<String> {
    let raw: Option<String> = sqlx::query_scalar(
        "SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND owner_id=$2 AND key=$3",
    )
    .bind(&a.workspace_id)
    .bind(format!("user:{}", a.user_id))
    .bind(key)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    raw.map(|s| serde_json::from_str(&s).unwrap())
}

#[tokio::test]
async fn product_state_is_private_and_exact_retries_and_equal_stale_values_preserve_revisions() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let key = "forge:desktop-tabs";
    let command = input(&f.actor, key, Some("opaque bytes"), 0);
    assert_eq!(
        state::save(&f.database, &f.actor, command.clone(), OPTIONS)
            .await
            .unwrap()["value"]["revision"],
        1
    );
    assert_eq!(
        state::save(&f.database, &f.actor, command.clone(), OPTIONS)
            .await
            .unwrap()["replayed"],
        true
    );
    let mut changed = command;
    changed["value"] = json!("different");
    assert!(matches!(
        state::save(&f.database, &f.actor, changed, OPTIONS).await,
        Err(StoreError::CommandReused)
    ));
    assert_eq!(
        save(&f, &f.actor, key, Some("opaque bytes"), 0)
            .await
            .unwrap()["value"]["revision"],
        1
    );
    assert!(
        save(&f, &f.actor, key, Some("stale new bytes"), 0)
            .await
            .is_err()
    );
    assert_eq!(
        entry(&f, &f.actor, key).await.unwrap()["value"],
        "opaque bytes"
    );
    assert!(entry(&f, &member, key).await.is_none());
    save(&f, &member, key, Some("Personal other tabs"), 0)
        .await
        .unwrap();
    assert_eq!(
        entry(&f, &f.actor, key).await.unwrap()["value"],
        "opaque bytes"
    );
    let page = snapshot(&f, &member).await;
    assert_eq!(page["workspaceId"], member.workspace_id);
    assert_eq!(page["userId"], member.user_id);
    assert_eq!(page["initiativeFeatureAvailable"], false);
    assert!(
        page["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["key"] == format!("forge:project-statuses:v1:{}", member.workspace_id))
    );
}

#[tokio::test]
async fn product_state_scopes_current_teams_features_and_shared_settings_without_alternate_writes()
{
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let team = team(&f, 1).await;
    let key = format!("forge:team-home:v1:{team}");
    let value = "{\"resources\":[],\"sections\":[]}";
    let command = input(&member, &key, Some(value), 0);
    state::save(&f.database, &member, command.clone(), OPTIONS)
        .await
        .unwrap();
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(entry(&f, &member, &key).await.is_none());
    assert!(
        state::save(&f.database, &member, command, OPTIONS)
            .await
            .is_err()
    );
    let triage = format!("forge:team-triage:v1:{team}");
    save(
        &f,
        &f.actor,
        &triage,
        Some("{\"enabled\":true,\"requirePriority\":false}"),
        0,
    )
    .await
    .unwrap();
    assert!(
        save(
            &f,
            &member,
            &triage,
            Some("{\"enabled\":false,\"requirePriority\":false}"),
            1
        )
        .await
        .is_err()
    );
    for key in [
        "unrelated".into(),
        "forge:workspace:foreign:preferences".into(),
        format!(
            "forge:workspace:{}:shared-initiatives:v1",
            f.actor.workspace_id
        ),
        "forge:signals:v1:any".into(),
        "forge:team-thread-summaries:v1:unknown".into(),
    ] {
        assert!(
            save(&f, &f.actor, &key, Some("{}"), 0).await.is_err(),
            "key {key}"
        );
    }
    let mut wrong = input(&f.actor, "forge:desktop-tabs", Some("[]"), 0);
    wrong["sessionId"] = json!("different-session");
    assert!(
        state::save(&f.database, &f.actor, wrong, OPTIONS)
            .await
            .is_err()
    );
    let external = super::team_key(&f).await;
    assert!(state::read(&f.database, &external, OPTIONS).await.is_err());
}

#[tokio::test]
async fn retained_issue_retry_batches_are_hidden_unchanged_and_can_be_explicitly_discarded() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let a = create(&f, team, "Archived").await;
    let b = create(&f, team, "Active").await;
    let aid = a["id"].as_str().unwrap().parse::<Uuid>().unwrap();
    let key = format!("forge:team-issue-edit-drafts:v1:{team}:{}", Uuid::new_v4());
    let value=serde_json::to_string(&json!({"commandKey":"uncertain","edits":[{"issueId":a["id"],"changes":{"title":"Keep this draft"}},{"issueId":b["id"],"changes":{"title":"Active draft"}}]})).unwrap();
    save(&f, &f.actor, &key, Some(&value), 0).await.unwrap();
    sqlx::query("UPDATE issues SET archived_at=now() WHERE id=$1")
        .bind(aid)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        entry(&f, &f.actor, &key).await.unwrap()["value"],
        Value::Null
    );
    let filtered=serde_json::to_string(&json!({"commandKey":"uncertain","edits":[{"issueId":b["id"],"changes":{"title":"Active draft"}}]})).unwrap();
    assert!(save(&f, &f.actor, &key, Some(&filtered), 1).await.is_err());
    assert_eq!(raw(&f, &f.actor, &key).await, Some(value.clone()));
    save(&f, &f.actor, &key, Some(&value), 1).await.unwrap();
    assert_eq!(raw(&f, &f.actor, &key).await, Some(value));
    save(&f, &f.actor, &key, None, 2).await.unwrap();
    assert_eq!(raw(&f, &f.actor, &key).await, None);
}

#[tokio::test]
async fn inbox_projection_merges_recoverable_entries_and_expires_irrecoverable_retry_payloads() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let a = create(&f, team, "Recoverable").await;
    let b = create(&f, team, "Visible").await;
    let aid = a["id"].as_str().unwrap().parse::<Uuid>().unwrap();
    let key = "forge:inbox:v1:[]";
    let value=serde_json::to_string(&json!({"entries":[{"issue":{"id":a["id"]},"draft":"Raw writing"},{"issue":{"id":b["id"]}}]})).unwrap();
    save(&f, &f.actor, key, Some(&value), 0).await.unwrap();
    sqlx::query("UPDATE issues SET deleted_at=now() WHERE id=$1")
        .bind(aid)
        .execute(&f.pool)
        .await
        .unwrap();
    let projected = entry(&f, &f.actor, key).await.unwrap()["value"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(!projected.contains("Raw writing"));
    save(&f, &f.actor, key, Some(&projected), 1).await.unwrap();
    assert!(
        raw(&f, &f.actor, key)
            .await
            .unwrap()
            .contains("Raw writing")
    );
    let expired = create(&f, team, "Expired copy").await;
    let retry = format!("forge:team-issue-edit-drafts:v1:{team}:expired");
    let payload=serde_json::to_string(&json!({"edits":[{"issueId":expired["id"],"changes":{"title":"Expired"}},{"issueId":b["id"],"changes":{"title":"Active"}}]})).unwrap();
    sqlx::query("UPDATE issues SET deleted_at=now()-interval '31 days' WHERE id=$1")
        .bind(expired["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
    save(&f, &f.actor, &retry, Some(&payload), 0).await.unwrap();
    let stored: Value = serde_json::from_str(&raw(&f, &f.actor, &retry).await.unwrap()).unwrap();
    assert_eq!(stored["requiresReview"], true);
    assert_eq!(stored["edits"].as_array().unwrap().len(), 1);
    assert_eq!(stored["edits"][0]["issueId"], b["id"]);
}

#[tokio::test]
async fn project_recovery_batches_redact_whole_payload_and_canonical_commands_dispatch_once() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let team = team(&f, 1).await;
    let id = Uuid::new_v4();
    let changes = json!([{"id":id,"expectedRevision":null,"changes":{"name":"Canonical via generic state","teamIds":[team]}}]);
    let raw_changes = serde_json::to_string(&changes).unwrap();
    let key = format!("forge:project-command:v1:{}", Uuid::new_v4());
    let command = input(&member, &key, Some(&raw_changes), 0);
    state::save(&f.database, &member, command.clone(), OPTIONS)
        .await
        .unwrap();
    assert_eq!(
        state::save(&f.database, &member, command, OPTIONS)
            .await
            .unwrap()["replayed"],
        true
    );
    let row = &projects::read(&f.database, &member).await.unwrap()["projects"][0];
    let batch = serde_json::to_string(
        &json!([{"id":id,"expectedRevision":row["revision"],"changes":{"name":"Uncertain edit"}}]),
    )
    .unwrap();
    let recovery = "forge:pending-recovery:v1:project";
    let envelope = serde_json::to_string(&json!({"key":key,"value":batch})).unwrap();
    save(&f, &member, recovery, Some(&envelope), 0)
        .await
        .unwrap();
    assert_eq!(
        entry(&f, &member, recovery).await.unwrap()["value"],
        envelope
    );
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        entry(&f, &member, recovery).await.unwrap()["value"],
        Value::Null
    );
    assert_eq!(raw(&f, &member, recovery).await, Some(envelope));
}

#[tokio::test]
async fn canonical_document_copies_are_retained_and_creation_file_tombstones_cannot_be_republished()
{
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let id = Uuid::new_v4();
    let fields = json!({"title":"Canonical","body":forge_core::documents::empty_body(),"icon":forge_core::documents::default_icon()});
    documents::command(
        &f.database,
        &f.actor,
        &Uuid::new_v4().to_string(),
        json!({"action":"create","id":id,"source":{"kind":"team","id":team},"fields":fields}),
        DocumentOptions {
            enabled: true,
            team_resources: true,
        },
    )
    .await
    .unwrap();
    let key = format!("forge:team-home:v1:{team}");
    let copy = json!({"kind":"document","id":id,"title":"Different raw legacy writing","body":{"type":"unsafe"}});
    let value = serde_json::to_string(&json!({"resources":[copy],"favorite":true})).unwrap();
    save(&f, &f.actor, &key, Some(&value), 0).await.unwrap();
    let stored: Value = serde_json::from_str(&raw(&f, &f.actor, &key).await.unwrap()).unwrap();
    assert_eq!(stored["resources"], json!([]));
    assert_eq!(stored["retainedDocumentDrafts"], json!([copy]));
    save(&f, &f.actor, &key, None, 1).await.unwrap();
    let retained: Value = serde_json::from_str(&raw(&f, &f.actor, &key).await.unwrap()).unwrap();
    assert_eq!(retained["retainedDocumentDrafts"], json!([copy]));
    let source_key = format!("forge:file-draft:v1:{}:creation", Uuid::new_v4());
    assert!(
        save(
            &f,
            &f.actor,
            &source_key,
            Some("{\"issueId\":\"invalid\"}"),
            0
        )
        .await
        .is_err()
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM product_state WHERE workspace_id=$1 AND key=$2")
            .bind(&f.actor.workspace_id)
            .bind(source_key)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
}
