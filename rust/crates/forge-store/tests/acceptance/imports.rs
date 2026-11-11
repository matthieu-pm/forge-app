use super::{
    Fixture, enter_workspace,
    issue_acceptance::{create, team},
};
use forge_core::{
    actor::{Actor, Authentication},
    imports::Modules,
};
use forge_store::{
    StoreError,
    imports::{self, ImportOptions},
};
use serde_json::{Value, json};
use uuid::Uuid;
const OPTIONS: ImportOptions = ImportOptions {
    modules: Modules {
        initiatives: true,
        documents: true,
        resources: true,
        views: true,
        milestones: true,
    },
};
fn identity(a: &Actor) -> Value {
    json!({"workspaceId":a.workspace_id,"sessionId":match &a.authentication{Authentication::Session{session_id}=>session_id.as_str(),_=>"invalid"}})
}
fn issue(title: &str) -> Value {
    let mut v = forge_core::issues::blank("todo");
    for (k, value) in [
        ("id", json!("legacy-issue")),
        ("number", json!(1)),
        ("title", json!(title)),
        ("creator", json!("old-author")),
        ("createdAt", json!("2026-01-01T00:00:00.000Z")),
        ("updatedAt", json!("2026-01-01T00:00:00.000Z")),
        ("statusChangedAt", json!("2026-01-01T00:00:00.000Z")),
        ("completedAt", Value::Null),
        ("suggestedLabel", json!("")),
    ] {
        v[k] = value;
    }
    v["description"] = json!("Private original description");
    v["attachments"] = json!([{"name":"private.txt","data":"data:text/plain;base64,aGVsbG8="}]);
    v
}
async fn source(f: &Fixture, a: &Actor, key: &str, raw: &str) {
    sqlx::query("INSERT INTO product_state(workspace_id,owner_id,owner_user_id,key,encoded_value) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,owner_id,key) DO UPDATE SET encoded_value=EXCLUDED.encoded_value").bind(&a.workspace_id).bind(format!("user:{}",a.user_id)).bind(&a.user_id).bind(key).bind(serde_json::to_string(raw).unwrap()).execute(&f.pool).await.unwrap();
}
async fn prepare(f: &Fixture, a: &Actor) -> Value {
    imports::prepare(&f.database, a, identity(a), OPTIONS)
        .await
        .unwrap()
}
async fn read(f: &Fixture, a: &Actor) -> Value {
    imports::read(&f.database, a, identity(a), OPTIONS)
        .await
        .unwrap()
}
async fn checkpoint(f: &Fixture, m: &Value) -> Value {
    let raw: String = sqlx::query_scalar("SELECT encoded_manifest FROM legacy_imports WHERE id=$1")
        .bind(m["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .fetch_one(&f.pool)
        .await
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}
async fn put_checkpoint(f: &Fixture, m: &Value) {
    sqlx::query("UPDATE legacy_imports SET encoded_manifest=$1 WHERE id=$2")
        .bind(serde_json::to_string(m).unwrap())
        .bind(m["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
}
fn backup(m: &Value) -> String {
    format!(
        "forge:legacy-conflict:v1:import-{}-0",
        m["id"].as_str().unwrap()
    )
}

#[tokio::test]
async fn import_preview_preserves_private_sources_and_concurrent_previews_share_checkpoint() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let key = format!("forge:team-issues:v1:{team}");
    let raw = json!({"version":1,"issues":[issue("Original title")]}).to_string();
    source(&f, &f.actor, &key, &raw).await;
    let (a, b) = tokio::join!(prepare(&f, &f.actor), prepare(&f, &f.actor));
    assert_eq!(a["id"], b["id"]);
    assert_eq!(a["totalCount"], 1);
    assert_eq!(a["pendingCount"], 1);
    assert_eq!(a["entries"][0]["title"], "Original title");
    assert!(a["entries"][0].get("draft").is_none());
    assert_eq!(a["entries"][0]["files"][0]["data"], "");
    let stored = checkpoint(&f, &a).await;
    assert!(stored["entries"][0].get("title").is_none());
    assert!(stored["entries"][0].get("draft").is_none());
    assert!(stored["entries"][0]["files"][0].get("data").is_none());
    assert!(stored["sources"][0].get("raw").is_none());
    assert!(!stored.to_string().contains("Private original description"));
    let encoded: String = sqlx::query_scalar(
        "SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND key=$2",
    )
    .bind(&f.actor.workspace_id)
    .bind(backup(&a))
    .fetch_one(&f.pool)
    .await
    .unwrap();
    let preserved: Value =
        serde_json::from_str(&serde_json::from_str::<String>(&encoded).unwrap()).unwrap();
    assert_eq!(preserved["value"], raw);
    assert_eq!(preserved["key"], key);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM issues WHERE workspace_id=$1")
        .bind(&f.actor.workspace_id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(read(&f, &f.actor).await[0]["id"], a["id"]);
}
#[tokio::test]
async fn import_preview_binds_owner_workspace_and_current_session() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let team = team(&f, 1).await;
    let key = format!("forge:team-issues:v1:{team}");
    source(
        &f,
        &f.actor,
        &key,
        &json!({"version":1,"issues":[issue("Owner only")]}).to_string(),
    )
    .await;
    let m = prepare(&f, &f.actor).await;
    assert_eq!(m["totalCount"], 1);
    assert!(prepare(&f, &member).await.is_null());
    assert_eq!(read(&f, &member).await, json!([]));
    let mut wrong = identity(&f.actor);
    wrong["sessionId"] = json!("stale");
    assert!(matches!(
        imports::prepare(&f.database, &f.actor, wrong, OPTIONS).await,
        Err(StoreError::Forbidden)
    ));
    let mut wrong = identity(&f.actor);
    wrong["workspaceId"] = json!(visitor.actor.workspace_id);
    assert!(matches!(
        imports::read(&f.database, &f.actor, wrong, OPTIONS).await,
        Err(StoreError::Forbidden)
    ));
    let mut key_actor = f.actor.clone();
    key_actor.authentication = Authentication::ApiKey {
        credential_id: Uuid::new_v4().to_string(),
    };
    assert!(matches!(
        imports::read(&f.database, &key_actor, identity(&key_actor), OPTIONS).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("UPDATE session SET active_organization_id=NULL WHERE token=$1")
        .bind(&f.token)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        imports::read(&f.database, &f.actor, identity(&f.actor), OPTIONS)
            .await
            .is_err()
    );
    assert_eq!(checkpoint(&f, &m).await["revision"], 0);
}
#[tokio::test]
async fn import_source_is_immutable_across_new_drafts_and_damaged_backup_quarantines() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let key = format!("forge:team-issues:v1:{team}");
    source(
        &f,
        &f.actor,
        &key,
        &json!({"version":1,"issues":[issue("First")]}).to_string(),
    )
    .await;
    let m = prepare(&f, &f.actor).await;
    source(
        &f,
        &f.actor,
        &key,
        &json!({"version":1,"issues":[issue("Second")]}).to_string(),
    )
    .await;
    let second = prepare(&f, &f.actor).await;
    assert_ne!(m["id"], second["id"]);
    let manifests = read(&f, &f.actor).await;
    assert_eq!(
        manifests
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["id"] == m["id"])
            .unwrap()["entries"][0]["title"],
        "First"
    );
    source(
        &f,
        &f.actor,
        &backup(&m),
        &json!({"key":key,"value":"changed source"}).to_string(),
    )
    .await;
    let manifests = read(&f, &f.actor).await;
    let broken = manifests
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == m["id"])
        .unwrap();
    assert_eq!(broken["entries"][0]["state"], "quarantined");
    assert_eq!(broken["entries"][0]["sourceValid"], false);
    assert_eq!(broken["entries"][0]["title"], "Unavailable source record");
    assert_eq!(broken["sourceErrors"].as_array().unwrap().len(), 2);
}
#[tokio::test]
async fn import_review_refreshes_live_candidates_and_revoked_team_visibility() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let team = team(&f, 1).await;
    let canonical = create(&f, team, "Current server title").await;
    let key = format!("forge:team-issues:v1:{team}");
    source(
        &f,
        &member,
        &key,
        &json!({"version":1,"issues":[issue("Private source title")]}).to_string(),
    )
    .await;
    let m = prepare(&f, &member).await;
    let mut stored = checkpoint(&f, &m).await;
    stored["entries"][0]["state"] = json!("review");
    stored["entries"][0]["conflict"] =
        json!({"fingerprint":"f".repeat(64),"candidates":[{"id":canonical["id"],"revision":0}]});
    put_checkpoint(&f, &stored).await;
    let live = read(&f, &member).await;
    assert_eq!(
        live[0]["entries"][0]["conflict"]["candidates"][0]["title"],
        "Current server title"
    );
    assert_eq!(
        live[0]["entries"][0]["draft"]["description"],
        "Private original description"
    );
    assert_eq!(live[0]["entries"][0]["draft"]["attachments"], json!([]));
    sqlx::query("UPDATE issues SET deleted_at=now() WHERE id=$1")
        .bind(canonical["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
    let live = read(&f, &member).await;
    assert_eq!(
        live[0]["entries"][0]["conflict"]["candidates"][0]["title"],
        "Unavailable shared record"
    );
    assert!(
        live[0]["entries"][0]["conflict"]["candidates"][0]
            .get("details")
            .is_none()
    );
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(read(&f, &member).await, json!([]));
}
#[tokio::test]
async fn completed_import_sources_wait_for_changed_modules_and_keep_source_backups() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let key = format!("forge:team-home:v1:{team}");
    source(
        &f,
        &f.actor,
        &key,
        &json!({"resources":[{"id":"legacy-doc","title":"Original","content":"Private content"}]})
            .to_string(),
    )
    .await;
    let m = prepare(&f, &f.actor).await;
    let mut stored = checkpoint(&f, &m).await;
    stored["completedAt"] = json!("2026-01-01T00:00:00.000Z");
    put_checkpoint(&f, &stored).await;
    assert!(prepare(&f, &f.actor).await.is_null());
    sqlx::query("UPDATE product_state SET encoded_value=NULL WHERE workspace_id=$1 AND key=$2")
        .bind(&f.actor.workspace_id)
        .bind(&key)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(prepare(&f, &f.actor).await.is_null());
    let mut changed = OPTIONS;
    changed.modules.views = false;
    let revived = imports::prepare(&f.database, &f.actor, identity(&f.actor), changed)
        .await
        .unwrap();
    assert_ne!(revived["id"], m["id"]);
    assert_eq!(revived["totalCount"], 1);
    changed.modules.documents = false;
    let disabled = imports::read(&f.database, &f.actor, identity(&f.actor), changed)
        .await
        .unwrap();
    assert_eq!(disabled, json!([]));
}
