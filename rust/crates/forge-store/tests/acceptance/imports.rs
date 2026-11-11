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

fn command(a: &Actor, m: &Value) -> Value {
    let mut v = identity(a);
    v["id"] = m["id"].clone();
    v["revision"] = m["revision"].clone();
    v
}
fn plain(id: &str, title: &str) -> Value {
    let mut v = issue(title);
    v["id"] = json!(id);
    v["description"] = json!(format!("Source for {title}"));
    v["attachments"] = json!([]);
    v
}
async fn batch(f: &Fixture, m: &Value) -> Value {
    imports::batch(&f.database, &f.actor, command(&f.actor, m), OPTIONS)
        .await
        .unwrap()
}
async fn report(f: &Fixture, m: &Value) -> Value {
    imports::download_report(&f.database, &f.actor, command(&f.actor, m), OPTIONS)
        .await
        .unwrap()
}
async fn choose(f: &Fixture, m: &Value, entry: &Value, choice: &str) -> Value {
    let mut input = command(&f.actor, m);
    input["entryId"] = entry["id"].clone();
    input["choice"] = json!(choice);
    input["conflictFingerprint"] = entry["conflict"]["fingerprint"].clone();
    input["ownershipConfirmed"] = json!(true);
    imports::choose(&f.database, &f.actor, input, OPTIONS)
        .await
        .unwrap()
}
async fn cutover(
    f: &Fixture,
    m: &Value,
    action: &str,
    fp: &Value,
    ack: bool,
) -> Result<Value, StoreError> {
    let mut input = command(&f.actor, m);
    input["action"] = json!(action);
    if !fp.is_null() {
        input["reportFingerprint"] = fp.clone();
    }
    input["acknowledgeExclusions"] = json!(ack);
    imports::cutover(&f.database, &f.actor, input, OPTIONS).await
}
async fn seed_issues(f: &Fixture, team: Uuid, issues: Vec<Value>) {
    source(
        f,
        &f.actor,
        &format!("forge:team-issues:v1:{team}"),
        &json!({"version":1,"issues":issues}).to_string(),
    )
    .await;
}
async fn count(f: &Fixture) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM issues WHERE workspace_id=$1")
        .bind(&f.actor.workspace_id)
        .fetch_one(&f.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn import_batches_bound_work_and_rollback_failed_records_without_repeating_receipts() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let mut records: Vec<_> = (0..12)
        .map(|i| plain(&format!("legacy-{i}"), &format!("Record {i}")))
        .collect();
    records[3]["assignee"] = json!("no-longer-a-member");
    seed_issues(&f, team, records).await;
    let initial = prepare(&f, &f.actor).await;
    let (first, replayed) = tokio::join!(batch(&f, &initial), batch(&f, &initial));
    assert_eq!(first["revision"], replayed["revision"]);
    assert_eq!(first["revision"], 1);
    assert_eq!(first["savedCount"], 9);
    assert_eq!(first["pendingCount"], 2);
    assert_eq!(count(&f).await, 9);
    let final_batch = batch(&f, &first).await;
    assert_eq!(final_batch["savedCount"], 11);
    assert_eq!(final_batch["pendingCount"], 0);
    assert_eq!(count(&f).await, 11);
    assert_eq!(
        final_batch["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["state"] == "quarantined")
            .count(),
        1
    );
    let (receipts,events):(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM command_receipts WHERE workspace_id=$1 AND operation='imports.batch@1'),(SELECT count(*) FROM command_outbox_events WHERE workspace_id=$1 AND topic='issue.created')").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!((receipts, events), (2, 11));
    let report = report(&f, &final_batch).await;
    assert_eq!(report["report"]["ready"], false);
    assert_eq!(report["report"]["counts"]["unresolved"], 1);
    assert!(
        cutover(
            &f,
            &final_batch,
            "cleanup",
            &report["report"]["fingerprint"],
            true
        )
        .await
        .is_err()
    );
    let paused = imports::pause(
        &f.database,
        &f.actor,
        command(&f.actor, &final_batch),
        OPTIONS,
    )
    .await
    .unwrap();
    assert_eq!(paused["automaticPaused"], true);
    assert_eq!(
        imports::pause(
            &f.database,
            &f.actor,
            command(&f.actor, &final_batch),
            OPTIONS
        )
        .await
        .unwrap()["revision"],
        paused["revision"]
    );
}

#[tokio::test]
async fn import_conflict_choices_expire_when_shared_data_changes_and_do_not_append_private_files() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let canonical = create(&f, team, "Matching title").await;
    let mut original = issue("Matching title");
    original["description"] = json!("Retained private text");
    seed_issues(&f, team, vec![original]).await;
    let initial = prepare(&f, &f.actor).await;
    let review = batch(&f, &initial).await;
    let entry = review["entries"][0].clone();
    assert_eq!(entry["state"], "review");
    assert_eq!(count(&f).await, 1);
    let chosen = choose(&f, &review, &entry, "keep-server").await;
    sqlx::query("UPDATE issues SET title='Changed shared title',revision=revision+1,properties=jsonb_set(properties,'{description}',$2) WHERE id=$1").bind(canonical["id"].as_str().unwrap().parse::<Uuid>().unwrap()).bind(json!("Retained private text")).execute(&f.pool).await.unwrap();
    let stale = batch(&f, &chosen).await;
    assert_eq!(stale["entries"][0]["state"], "review");
    assert_ne!(
        stale["entries"][0]["conflict"]["fingerprint"],
        entry["conflict"]["fingerprint"]
    );
    // A vanished candidate cannot be selected by an old decision. Keeping a
    // separate copy requires a new review and receives a new canonical identity.
    let chosen = choose(&f, &stale, &stale["entries"][0], "keep-both").await;
    let saved = batch(&f, &chosen).await;
    assert_eq!(saved["savedCount"], 1);
    assert_eq!(count(&f).await, 2);
    assert_ne!(saved["entries"][0]["canonicalId"], canonical["id"]);
    assert_eq!(saved["fileCount"], 1);
    let legacy: Option<String> = sqlx::query_scalar("SELECT legacy_id FROM issues WHERE id=$1")
        .bind(
            saved["entries"][0]["canonicalId"]
                .as_str()
                .unwrap()
                .parse::<Uuid>()
                .unwrap(),
        )
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert!(legacy.is_none());
}

#[tokio::test]
async fn canonical_source_projections_cannot_create_duplicates_and_deleted_targets_block_reconciliation()
 {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let canonical = create(&f, team, "Existing projection").await;
    seed_issues(&f, team, vec![canonical.clone()]).await;
    let prepared = prepare(&f, &f.actor).await;
    let review = batch(&f, &prepared).await;
    assert_eq!(review["entries"][0]["state"], "review");
    let chosen = choose(&f, &review, &review["entries"][0], "keep-both").await;
    let blocked = batch(&f, &chosen).await;
    assert_eq!(blocked["entries"][0]["state"], "review");
    assert_eq!(count(&f).await, 1);
    let chosen = choose(&f, &blocked, &blocked["entries"][0], "keep-server").await;
    let saved = batch(&f, &chosen).await;
    assert_eq!(saved["savedCount"], 1);
    sqlx::query("UPDATE issues SET deleted_at=now() WHERE id=$1")
        .bind(canonical["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
    let r = report(&f, &saved).await;
    assert_eq!(r["report"]["ready"], false);
    let retry = imports::retry(&f.database, &f.actor, command(&f.actor, &saved), OPTIONS)
        .await
        .unwrap();
    let review = batch(&f, &retry).await;
    assert_eq!(review["entries"][0]["state"], "review");
    assert_eq!(review["entries"][0]["conflict"]["candidates"], json!([]));
    assert_eq!(count(&f).await, 1);
}

#[tokio::test]
async fn import_cleanup_requires_current_report_preserves_backups_favorites_and_later_source_edits()
{
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let mut original = plain("starred", "Starred issue");
    original["favorite"] = json!(true);
    seed_issues(&f, team, vec![original]).await;
    let prepared = prepare(&f, &f.actor).await;
    let saved = batch(&f, &prepared).await;
    let r = report(&f, &saved).await;
    assert_eq!(r["report"]["ready"], true, "{r}");
    let reconciled = cutover(&f, &saved, "reconcile", &Value::Null, false)
        .await
        .unwrap();
    let completed = cutover(
        &f,
        &reconciled,
        "complete",
        &reconciled["reconciliation"]["fingerprint"],
        true,
    )
    .await
    .unwrap();
    assert!(completed["completedAt"].is_string());
    let cleaned = cutover(
        &f,
        &completed,
        "cleanup",
        &completed["reconciliation"]["fingerprint"],
        true,
    )
    .await
    .unwrap();
    assert!(cleaned["cleanedAt"].is_string());
    let raw: String = sqlx::query_scalar(
        "SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND key=$2",
    )
    .bind(&f.actor.workspace_id)
    .bind(format!("forge:team-issues:v1:{team}"))
    .fetch_one(&f.pool)
    .await
    .unwrap();
    let body: Value = serde_json::from_str(&serde_json::from_str::<String>(&raw).unwrap()).unwrap();
    assert_eq!(body["issues"], json!([]));
    let raw: String = sqlx::query_scalar(
        "SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND key=$2",
    )
    .bind(&f.actor.workspace_id)
    .bind(format!("forge:team-issue-favorites:v1:{team}"))
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&serde_json::from_str::<String>(&raw).unwrap()).unwrap(),
        json!([saved["entries"][0]["canonicalId"]])
    );
    assert!(
        imports::retry(&f.database, &f.actor, command(&f.actor, &cleaned), OPTIONS)
            .await
            .is_err()
    );
    assert!(prepare(&f, &f.actor).await.is_null());
    assert_eq!(batch(&f, &prepared).await["revision"], cleaned["revision"]);
    let backup_count:i64=sqlx::query_scalar("SELECT count(*) FROM product_state WHERE workspace_id=$1 AND key=$2 AND encoded_value IS NOT NULL").bind(&f.actor.workspace_id).bind(backup(&prepared)).fetch_one(&f.pool).await.unwrap();
    assert_eq!(backup_count, 1);
    let updated = plain("next", "Later draft");
    seed_issues(&f, team, vec![updated.clone()]).await;
    let next = prepare(&f, &f.actor).await;
    let next = batch(&f, &next).await;
    let r = report(&f, &next).await;
    seed_issues(&f, team, vec![updated, plain("newer", "Newer draft")]).await;
    let cleaned = cutover(&f, &next, "cleanup", &r["report"]["fingerprint"], true)
        .await
        .unwrap();
    assert_eq!(cleaned["cleanedSources"], json!([]));
    let raw: String = sqlx::query_scalar(
        "SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND key=$2",
    )
    .bind(&f.actor.workspace_id)
    .bind(format!("forge:team-issues:v1:{team}"))
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(raw.contains("Newer draft"));
}

fn remap(v: &mut Value, a: &Actor, team: Uuid) {
    match v {
        Value::String(s) => {
            if s == "abcdefab-0000-4000-8000-000000000001" {
                *s = team.to_string();
            } else if s == "user" {
                *s = a.user_id.clone();
            } else if s == "workspace" {
                *s = a.workspace_id.clone();
            }
        }
        Value::Array(items) => {
            for v in items {
                remap(v, a, team)
            }
        }
        Value::Object(items) => {
            for v in items.values_mut() {
                remap(v, a, team)
            }
        }
        _ => {}
    }
}
async fn seed_content(f: &Fixture, team: Uuid) {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../../reference-fixtures.json")).unwrap();
    for fragment in [
        ":initiatives:v1",
        "forge:team-home:v1:",
        ":custom-views:v1:",
    ] {
        let case = fixture["importContracts"]["manifests"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| {
                c["input"]["modules"]["documents"] == true
                    && c["input"]["sources"][0]["key"]
                        .as_str()
                        .unwrap()
                        .contains(fragment)
            })
            .unwrap();
        let mut body: Value =
            serde_json::from_str(case["input"]["sources"][0]["raw"].as_str().unwrap()).unwrap();
        remap(&mut body, &f.actor, team);
        let key = if fragment.contains("initiatives") {
            format!("forge:workspace:{}:initiatives:v1", f.actor.workspace_id)
        } else if fragment.contains("custom-views") {
            body["views"].as_array_mut().unwrap().truncate(2);
            format!(
                "forge:workspace:{}:custom-views:v1:{}",
                f.actor.workspace_id, f.actor.user_id
            )
        } else {
            format!("forge:team-home:v1:{team}")
        };
        source(f, &f.actor, &key, &body.to_string()).await;
    }
}
#[tokio::test]
async fn reviewed_content_imports_resolve_projects_milestones_sections_documents_initiatives_and_views()
 {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    seed_content(&f, team).await;
    let mut root = plain("root", "Root issue");
    root["project"] = json!("project");
    root["milestone"] = json!("milestone");
    let mut child = plain("child", "Child issue");
    child["parentId"] = json!("root");
    child["project"] = json!("project");
    child["cycle"] = json!("2026-01-01");
    seed_issues(&f, team, vec![child, root]).await;
    let mut m = prepare(&f, &f.actor).await;
    for _ in 0..12 {
        m = batch(&f, &m).await;
        assert!(
            !m["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["state"] == "quarantined"),
            "{m}"
        );
        if m["savedCount"] == m["totalCount"] {
            break;
        }
        let entries = m["entries"].as_array().unwrap().clone();
        let mut reviewed = false;
        for e in entries.iter().filter(|e| e["state"] == "review") {
            if e["conflict"]["contentConfirmation"]["newRecord"] == true {
                let mut missing = command(&f.actor, &m);
                missing["entryId"] = e["id"].clone();
                missing["choice"] = json!("confirm-content");
                missing["conflictFingerprint"] = e["conflict"]["fingerprint"].clone();
                assert!(
                    imports::choose(&f.database, &f.actor, missing, OPTIONS)
                        .await
                        .is_err()
                );
                m = choose(&f, &m, e, "confirm-content").await;
            } else {
                assert_eq!(
                    e["conflict"]["candidates"].as_array().unwrap().len(),
                    1,
                    "{e}"
                );
                m = choose(&f, &m, e, "keep-server").await;
            }
            reviewed = true;
        }
        assert!(
            reviewed || m["pendingCount"].as_u64().unwrap() > 0,
            "No progress: {m}"
        );
    }
    assert_eq!(m["savedCount"], m["totalCount"], "{m}");
    let r = report(&f, &m).await;
    assert_eq!(r["report"]["ready"], true, "{r}");
    let records = m["entries"].as_array().unwrap();
    for kind in [
        "issue",
        "project",
        "initiative",
        "milestone",
        "document",
        "resource",
        "view",
    ] {
        assert!(
            records
                .iter()
                .any(|e| e["kind"] == kind && e["state"] == "saved"),
            "{kind}"
        );
    }
    let (projects,initiatives,documents,views,cycles):(i64,i64,i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM projects WHERE workspace_id=$1),(SELECT count(*) FROM initiatives WHERE workspace_id=$1),(SELECT count(*) FROM documents WHERE workspace_id=$1),(SELECT count(*) FROM saved_views WHERE workspace_id=$1),(SELECT count(*) FROM issue_cycles WHERE workspace_id=$1)").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(
        (projects, initiatives, documents, views, cycles),
        (1, 1, 2, 2, 1)
    );
    let roots: Vec<(String, Option<Uuid>, Option<Uuid>)> = sqlx::query_as(
        "SELECT title,parent_id,project_id FROM issues WHERE workspace_id=$1 ORDER BY title",
    )
    .bind(&f.actor.workspace_id)
    .fetch_all(&f.pool)
    .await
    .unwrap();
    assert_eq!(roots.len(), 2);
    assert!(roots[0].1.is_some());
    assert!(roots.iter().all(|r| r.2.is_some()));
    let receipts:Vec<Value>=sqlx::query_scalar("SELECT response_body::jsonb FROM command_receipts WHERE workspace_id=$1 AND operation='imports.batch@1'").bind(&f.actor.workspace_id).fetch_all(&f.pool).await.unwrap();
    assert!(
        receipts
            .iter()
            .all(|r| r.as_object().unwrap().len() == 1 && r["id"] == m["id"])
    );
}

async fn uploaded(f: &Fixture, issue: Uuid, file: &Value) -> Uuid {
    let uid = Uuid::new_v4();
    let storage = format!("files/{uid}");
    sqlx::query("INSERT INTO file_upload_intents(id,workspace_id,user_id,command_key,input_hash,target,name,content_type,size_bytes,checksum,storage_reference,state,expires_at,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ready',now()+interval '1 day',$12)").bind(uid).bind(&f.actor.workspace_id).bind(&f.actor.user_id).bind(Uuid::new_v4()).bind("b".repeat(64)).bind(json!({"kind":"issue","id":issue})).bind(file["name"].as_str().unwrap()).bind(file["contentType"].as_str().unwrap()).bind(file["sizeBytes"].as_i64().unwrap()).bind(file["checksum"].as_str().unwrap()).bind(&storage).bind(json!({"checksum":file["checksum"],"sizeBytes":file["sizeBytes"],"contentType":file["contentType"]})).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO resource_files(id,workspace_id,created_by_user_id,issue_id,attachment_state,name,content_type,size_bytes,checksum,storage_reference) VALUES($1,$2,$3,$4,'unbound',$5,$6,$7,$8,$9)").bind(uid).bind(&f.actor.workspace_id).bind(&f.actor.user_id).bind(issue).bind(file["name"].as_str().unwrap()).bind(file["contentType"].as_str().unwrap()).bind(file["sizeBytes"].as_i64().unwrap()).bind(file["checksum"].as_str().unwrap()).bind(storage).execute(&f.pool).await.unwrap();
    uid
}
fn file_command(f: &Fixture, m: &Value, e: &Value, file: Uuid) -> Value {
    let mut input = command(&f.actor, m);
    input["entryId"] = e["id"].clone();
    input["index"] = json!(0);
    input["fileId"] = json!(file);
    input
}
#[tokio::test]
async fn imported_files_require_verified_upload_metadata_and_attach_exactly_once() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let mut original = issue("Files");
    original["attachments"][0]["width"] = json!(75);
    seed_issues(&f, team, vec![original]).await;
    let prepared = prepare(&f, &f.actor).await;
    let saved = batch(&f, &prepared).await;
    let entry = &saved["entries"][0];
    assert_eq!(saved["fileCount"], 1);
    assert!(
        entry["files"][0]["data"]
            .as_str()
            .unwrap()
            .starts_with("data:")
    );
    let issue = entry["canonicalId"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    let file = uploaded(&f, issue, &entry["files"][0]).await;
    let input = file_command(&f, &saved, entry, file);
    sqlx::query("UPDATE file_upload_intents SET result=jsonb_set(result,'{checksum}','\"wrong\"'::jsonb) WHERE id=$1").bind(file).execute(&f.pool).await.unwrap();
    assert!(
        imports::finalize_file(&f.database, &f.actor, input.clone(), OPTIONS)
            .await
            .is_err()
    );
    let state: String =
        sqlx::query_scalar("SELECT attachment_state FROM resource_files WHERE id=$1")
            .bind(file)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(state, "unbound");
    sqlx::query(
        "UPDATE file_upload_intents SET result=jsonb_set(result,'{checksum}',$2) WHERE id=$1",
    )
    .bind(file)
    .bind(&entry["files"][0]["checksum"])
    .execute(&f.pool)
    .await
    .unwrap();
    let (first, replay) = tokio::join!(
        imports::finalize_file(&f.database, &f.actor, input.clone(), OPTIONS),
        imports::finalize_file(&f.database, &f.actor, input, OPTIONS)
    );
    let first = first.unwrap();
    assert_eq!(first["revision"], replay.unwrap()["revision"]);
    assert_eq!(first["fileCount"], 0);
    assert_eq!(first["entries"][0]["files"][0]["fileId"], file.to_string());
    let props: Value = sqlx::query_scalar("SELECT properties FROM issues WHERE id=$1")
        .bind(issue)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(props["attachments"].as_array().unwrap().len(), 1);
    assert_eq!(props["attachments"][0]["width"], 75);
    assert_eq!(props["attachments"][0]["id"], entry["files"][0]["legacyId"]);
    let r = report(&f, &first).await;
    assert_eq!(r["report"]["ready"], true, "{r}");
    assert_eq!(r["report"]["counts"]["verifiedFiles"], 1);
    let n:i64=sqlx::query_scalar("SELECT count(*) FROM command_outbox_events WHERE workspace_id=$1 AND topic='issue.file.attached'").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(n, 1);
}
#[tokio::test]
async fn import_file_migration_preserves_inline_anchors_and_does_not_accept_later_shared_edits() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let canonical = create(&f, team, "Inline legacy").await;
    let uid = canonical["id"].as_str().unwrap().parse::<Uuid>().unwrap();
    let mut original = issue("Inline legacy");
    original["attachments"][0]["id"] = json!("inline-anchor");
    original["attachments"][0]["width"] = json!(80);
    sqlx::query("UPDATE issues SET legacy_id=$1,properties=jsonb_set(properties,'{attachments}',$2) WHERE id=$3").bind(original["id"].as_str().unwrap()).bind(&original["attachments"]).bind(uid).execute(&f.pool).await.unwrap();
    seed_issues(&f, team, vec![original]).await;
    let prepared = prepare(&f, &f.actor).await;
    let review = batch(&f, &prepared).await;
    assert_eq!(
        review["entries"][0]["conflict"]["candidates"][0]["canMigrateFiles"],
        true
    );
    let chosen = choose(&f, &review, &review["entries"][0], "migrate-files").await;
    let saved = batch(&f, &chosen).await;
    assert_eq!(saved["entries"][0]["replaceLegacyFiles"], true);
    assert_eq!(count(&f).await, 1);
    let entry = &saved["entries"][0];
    let file = uploaded(&f, uid, &entry["files"][0]).await;
    sqlx::query("UPDATE issues SET title='Later shared edit',revision=revision+1 WHERE id=$1")
        .bind(uid)
        .execute(&f.pool)
        .await
        .unwrap();
    let bound = imports::finalize_file(
        &f.database,
        &f.actor,
        file_command(&f, &saved, entry, file),
        OPTIONS,
    )
    .await
    .unwrap();
    let props: Value = sqlx::query_scalar("SELECT properties FROM issues WHERE id=$1")
        .bind(uid)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(props["attachments"][0]["id"], "inline-anchor");
    assert_eq!(props["attachments"][0]["width"], 80);
    assert_eq!(props["attachments"][0]["data"], "");
    assert_eq!(report(&f, &bound).await["report"]["ready"], false);
    let retry = imports::retry(&f.database, &f.actor, command(&f.actor, &bound), OPTIONS)
        .await
        .unwrap();
    let review = batch(&f, &retry).await;
    assert_eq!(review["entries"][0]["state"], "review");
}
#[tokio::test]
async fn settled_reference_mappings_require_the_original_owner_backup_and_live_permissions() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    seed_issues(&f, team, vec![plain("parent", "Settled parent")]).await;
    let prepared = prepare(&f, &f.actor).await;
    let saved = batch(&f, &prepared).await;
    let r = report(&f, &saved).await;
    let completed = cutover(&f, &saved, "complete", &r["report"]["fingerprint"], true)
        .await
        .unwrap();
    let mut child = plain("child", "Referenced child");
    child["parentId"] = json!("parent");
    seed_issues(&f, team, vec![child]).await;
    let next = prepare(&f, &f.actor).await;
    assert!(next.get("referenceContext").is_none());
    let next = batch(&f, &next).await;
    assert_eq!(next["savedCount"], 1);
    let r = report(&f, &next).await;
    assert_eq!(r["report"]["ready"], true, "{r}");
    let mut child = plain("child-two", "Untrusted child");
    child["parentId"] = json!("parent");
    seed_issues(&f, team, vec![child]).await;
    let next = prepare(&f, &f.actor).await;
    source(&f, &f.actor, &backup(&completed), "damaged").await;
    let next = batch(&f, &next).await;
    assert_eq!(next["entries"][0]["state"], "quarantined");
    assert_eq!(count(&f).await, 2);
    let mut input = command(&f.actor, &next);
    input["sessionId"] = json!("wrong");
    assert!(matches!(
        imports::batch(&f.database, &f.actor, input, OPTIONS).await,
        Err(StoreError::Forbidden)
    ));
}
