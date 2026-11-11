use super::{
    Fixture, enter_workspace,
    issue_acceptance::{create, team},
};
use forge_core::{actor::Actor, documents as contract};
use forge_store::{
    StoreError,
    documents::{self, DocumentOptions},
    planning::{self, Resource},
    projects,
};
use serde_json::{Value, json};
use uuid::Uuid;
const OPTIONS: DocumentOptions = DocumentOptions {
    enabled: true,
    team_resources: true,
};
fn fields(title: &str) -> Value {
    json!({"title":title,"body":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":title}]}]},"icon":contract::default_icon(),"sectionId":null})
}
fn creation(id: Uuid, source: Value) -> Value {
    json!({"action":"create","id":id,"source":source,"fields":fields("Document")})
}
async fn command(f: &Fixture, a: &Actor, input: Value) -> Result<Value, StoreError> {
    documents::command(&f.database, a, &Uuid::new_v4().to_string(), input, OPTIONS).await
}
async fn read(f: &Fixture, a: &Actor, id: Uuid) -> Result<Value, StoreError> {
    documents::read(&f.database, a, None, Some(id), OPTIONS)
        .await
        .map(|v| v[0].clone())
}
async fn counts(f: &Fixture, id: Uuid) -> (i64, i64, i64, i64) {
    sqlx::query_as("SELECT (SELECT count(*) FROM documents WHERE id=$1),(SELECT count(*) FROM document_revisions WHERE document_id=$1),(SELECT count(*) FROM command_receipts WHERE workspace_id=$2 AND operation='documents.write@1'),(SELECT count(*) FROM command_outbox_events WHERE workspace_id=$2 AND topic LIKE 'document.%')").bind(id).bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap()
}

#[tokio::test]
async fn concurrent_document_edits_commit_one_revision_and_receipt_replays_reauthorize() {
    let f = Fixture::new().await;
    let id = Uuid::new_v4();
    let input = creation(id, json!({"kind":"workspace"}));
    let key = Uuid::new_v4().to_string();
    let first = documents::command(&f.database, &f.actor, &key, input.clone(), OPTIONS)
        .await
        .unwrap();
    assert_eq!(first, json!({"status":"saved","id":id,"revision":1}));
    assert_eq!(
        documents::command(&f.database, &f.actor, &key, input.clone(), OPTIONS)
            .await
            .unwrap(),
        first
    );
    let mut changed = input.clone();
    changed["fields"] = fields("Different");
    assert!(matches!(
        documents::command(&f.database, &f.actor, &key, changed, OPTIONS).await,
        Err(StoreError::CommandReused)
    ));
    let edit =
        |title: &str| json!({"action":"save","id":id,"expectedRevision":1,"fields":fields(title)});
    let (a, b) = tokio::join!(
        command(&f, &f.actor, edit("A")),
        command(&f, &f.actor, edit("B"))
    );
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(
        usize::from(a["status"] == "saved") + usize::from(b["status"] == "saved"),
        1
    );
    let conflict = if a["status"] == "conflict" { a } else { b };
    assert_eq!(conflict["current"]["revision"], 2);
    assert_eq!(counts(&f, id).await, (1, 2, 2, 2));
    sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        documents::command(&f.database, &f.actor, &key, input, OPTIONS).await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn private_sources_sharing_and_receipts_follow_current_membership_and_role() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let team = team(&f, 1).await;
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
    let id = Uuid::new_v4();
    command(&f, &f.actor, creation(id, json!({"kind":"team","id":team})))
        .await
        .unwrap();
    assert!(read(&f, &member, id).await.is_err());
    let visible = documents::read(
        &f.database,
        &member,
        Some(json!({"kind":"workspace"})),
        None,
        OPTIONS,
    )
    .await
    .unwrap();
    assert_eq!(visible, json!([]));
    assert_eq!(
        documents::share(&f.database, &f.actor, id, true, OPTIONS)
            .await
            .unwrap(),
        json!({"id":id})
    );
    let row = read(&f, &member, id).await.unwrap();
    assert_eq!(row["sharedWithWorkspace"], true);
    assert_eq!(row["canDelete"], false);
    assert_eq!(row["canShare"], false);
    assert!(row.get("teamId").is_none());
    assert!(
        command(
            &f,
            &member,
            json!({"action":"share","id":id,"expectedRevision":2,"shared":false})
        )
        .await
        .is_err()
    );
    let edit = json!({"action":"save","id":id,"expectedRevision":2,"fields":fields("Member edit")});
    let key = Uuid::new_v4().to_string();
    assert_eq!(
        documents::command(&f.database, &member, &key, edit.clone(), OPTIONS)
            .await
            .unwrap()["revision"],
        3
    );
    assert!(
        command(
            &f,
            &member,
            json!({"action":"delete","id":id,"expectedRevision":3})
        )
        .await
        .is_err()
    );
    command(
        &f,
        &f.actor,
        json!({"action":"share","id":id,"expectedRevision":3,"shared":false}),
    )
    .await
    .unwrap();
    assert!(
        documents::command(&f.database, &member, &key, edit, OPTIONS)
            .await
            .is_err()
    );
    assert!(
        documents::history(&f.database, &member, id, None, OPTIONS)
            .await
            .is_err()
    );
    assert_eq!(
        planning::get(&f.database, &member, Resource::Document, id)
            .await
            .unwrap(),
        Value::Null
    );
    assert!(
        documents::read(
            &f.database,
            &member,
            Some(json!({"kind":"team","id":team})),
            None,
            OPTIONS
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn owners_delete_tombstones_and_uncertain_create_and_delete_receipts_remain_safe() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let id = Uuid::new_v4();
    let create = creation(id, json!({"kind":"workspace"}));
    let create_key = Uuid::new_v4().to_string();
    documents::command(&f.database, &member, &create_key, create.clone(), OPTIONS)
        .await
        .unwrap();
    assert_eq!(read(&f, &member, id).await.unwrap()["canDelete"], true);
    let delete = json!({"action":"delete","id":id,"expectedRevision":1});
    let key = Uuid::new_v4().to_string();
    assert_eq!(
        documents::command(&f.database, &member, &key, delete.clone(), OPTIONS)
            .await
            .unwrap()["revision"],
        2
    );
    assert_eq!(
        documents::command(&f.database, &member, &key, delete, OPTIONS)
            .await
            .unwrap()["revision"],
        2
    );
    assert_eq!(
        documents::command(&f.database, &member, &create_key, create.clone(), OPTIONS)
            .await
            .unwrap()["revision"],
        1
    );
    assert_eq!(
        command(&f, &member, create).await.unwrap(),
        json!({"status":"conflict","current":null})
    );
    assert!(read(&f, &f.actor, id).await.is_err());
    assert!(
        documents::history(&f.database, &member, id, None, OPTIONS)
            .await
            .is_err()
    );
    assert!(
        command(
            &f,
            &member,
            json!({"action":"restore","id":id,"expectedRevision":2,"revision":1})
        )
        .await
        .is_err()
    );
    assert_eq!(counts(&f, id).await, (1, 2, 2, 2));
}

#[tokio::test]
async fn document_history_restores_append_and_page_and_unsafe_snapshots_stay_recoverable() {
    let f = Fixture::new().await;
    let id = Uuid::new_v4();
    command(&f, &f.actor, creation(id, json!({"kind":"workspace"})))
        .await
        .unwrap();
    for revision in 1..32 {
        command(&f,&f.actor,json!({"action":"save","id":id,"expectedRevision":revision,"fields":fields(&format!("Revision {}",revision+1))})).await.unwrap();
    }
    let history = documents::history(&f.database, &f.actor, id, None, OPTIONS)
        .await
        .unwrap();
    assert_eq!(history.as_array().unwrap().len(), 30);
    assert_eq!(history[0]["revision"], 32);
    assert_eq!(history[29]["revision"], 3);
    let rest = documents::history(&f.database, &f.actor, id, Some(3), OPTIONS)
        .await
        .unwrap();
    assert_eq!(rest.as_array().unwrap().len(), 2);
    assert_eq!(rest[1]["revision"], 1);
    assert_eq!(
        documents::history(&f.database, &f.actor, id, Some(0), OPTIONS)
            .await
            .unwrap(),
        history
    );
    assert_eq!(
        command(
            &f,
            &f.actor,
            json!({"action":"restore","id":id,"expectedRevision":32,"revision":1})
        )
        .await
        .unwrap()["revision"],
        33
    );
    assert_eq!(read(&f, &f.actor, id).await.unwrap()["title"], "Document");
    assert_eq!(
        command(
            &f,
            &f.actor,
            json!({"action":"restore","id":id,"expectedRevision":32,"revision":2})
        )
        .await
        .unwrap()["status"],
        "conflict"
    );
    let unsafe_body =
        json!({"type":"doc","content":[{"type":"script","text":"recover my raw writing"}]});
    sqlx::query("UPDATE document_revisions SET snapshot=jsonb_set(snapshot,'{body}',$1) WHERE document_id=$2 AND revision=1").bind(&unsafe_body).bind(id).execute(&f.pool).await.unwrap();
    assert!(
        command(
            &f,
            &f.actor,
            json!({"action":"restore","id":id,"expectedRevision":33,"revision":1})
        )
        .await
        .is_err()
    );
    let raw = documents::history(&f.database, &f.actor, id, Some(2), OPTIONS)
        .await
        .unwrap();
    assert_eq!(raw[0]["unsafeBody"], true);
    assert_eq!(raw[0]["body"], unsafe_body);
    sqlx::query("UPDATE documents SET body=$1,icon='{}' WHERE id=$2")
        .bind(&unsafe_body)
        .bind(id)
        .execute(&f.pool)
        .await
        .unwrap();
    let row = read(&f, &f.actor, id).await.unwrap();
    assert_eq!(row["unsafeBody"], true);
    assert_eq!(row["body"], unsafe_body);
    assert_eq!(row["icon"], contract::default_icon());
    command(
        &f,
        &f.actor,
        json!({"action":"share","id":id,"expectedRevision":33,"shared":true}),
    )
    .await
    .unwrap();
    assert_eq!(read(&f, &f.actor, id).await.unwrap()["body"], unsafe_body);
}

#[tokio::test]
async fn unsafe_content_revision_failures_and_disabled_transports_have_no_partial_effects() {
    let f = Fixture::new().await;
    let id = Uuid::new_v4();
    let mut input = creation(id, json!({"kind":"workspace"}));
    input["fields"]["body"] = json!({"type":"script"});
    assert!(command(&f, &f.actor, input).await.is_err());
    assert_eq!(counts(&f, id).await, (0, 0, 0, 0));
    let create = creation(id, json!({"kind":"workspace"}));
    assert!(
        documents::command(
            &f.database,
            &f.actor,
            &Uuid::new_v4().to_string(),
            create.clone(),
            DocumentOptions {
                enabled: false,
                ..OPTIONS
            }
        )
        .await
        .is_err()
    );
    let external = super::team_key(&f).await;
    assert!(command(&f, &external, create.clone()).await.is_err());
    command(&f, &f.actor, create).await.unwrap();
    sqlx::query("INSERT INTO document_revisions(workspace_id,document_id,revision,snapshot) VALUES($1,$2,2,$3)").bind(&f.actor.workspace_id).bind(id).bind(fields("Occupied revision")).execute(&f.pool).await.unwrap();
    assert!(
        command(
            &f,
            &f.actor,
            json!({"action":"save","id":id,"expectedRevision":1,"fields":fields("Must roll back")})
        )
        .await
        .is_err()
    );
    assert_eq!(read(&f, &f.actor, id).await.unwrap()["revision"], 1);
    assert_eq!(counts(&f, id).await, (1, 2, 1, 1));
    let foreign = Fixture::new().await;
    assert!(read(&f, &foreign.actor, id).await.is_err());
    assert!(
        documents::read(
            &f.database,
            &f.actor,
            Some(json!({"kind":"workspace"})),
            None,
            DocumentOptions {
                enabled: false,
                ..OPTIONS
            }
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn team_sections_validate_new_placements_preserve_legacy_and_restore_removed_sections_to_root()
 {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let id = Uuid::new_v4();
    let section = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO team_resource_boards(workspace_id,team_id,fields) VALUES($1,$2,$3)")
        .bind(&f.actor.workspace_id)
        .bind(team)
        .bind(json!({"sections":[{"id":section,"name":"Docs"}],"links":[],"order":[]}))
        .execute(&f.pool)
        .await
        .unwrap();
    let mut input = creation(id, json!({"kind":"team","id":team}));
    input["fields"]["sectionId"] = json!(section);
    command(&f, &f.actor, input.clone()).await.unwrap();
    let mut invalid = fields("Bad section");
    invalid["sectionId"] = json!("removed");
    assert!(
        command(
            &f,
            &f.actor,
            json!({"action":"save","id":id,"expectedRevision":1,"fields":invalid})
        )
        .await
        .is_err()
    );
    command(
        &f,
        &f.actor,
        json!({"action":"save","id":id,"expectedRevision":1,"fields":fields("Root")}),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE team_resource_boards SET fields=jsonb_set(fields,'{sections}','[]') WHERE team_id=$1").bind(team).execute(&f.pool).await.unwrap();
    command(
        &f,
        &f.actor,
        json!({"action":"restore","id":id,"expectedRevision":2,"revision":1}),
    )
    .await
    .unwrap();
    assert_eq!(
        read(&f, &f.actor, id).await.unwrap()["sectionId"],
        Value::Null
    );
    sqlx::query("UPDATE documents SET section_id='legacy-section' WHERE id=$1")
        .bind(id)
        .execute(&f.pool)
        .await
        .unwrap();
    let mut legacy = fields("Preserved");
    legacy["sectionId"] = json!("legacy-section");
    command(
        &f,
        &f.actor,
        json!({"action":"save","id":id,"expectedRevision":3,"fields":legacy}),
    )
    .await
    .unwrap();
    assert_eq!(
        read(&f, &f.actor, id).await.unwrap()["sectionId"],
        "legacy-section"
    );
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
    documents::share(&f.database, &f.actor, id, true, OPTIONS)
        .await
        .unwrap();
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    assert!(
        command(
            &f,
            &member,
            json!({"action":"save","id":id,"expectedRevision":5,"fields":fields("Remove section")})
        )
        .await
        .is_err()
    );
}

async fn seed_copy(f: &Fixture, a: &Actor, team: Uuid, state: Value) -> Uuid {
    let id = Uuid::new_v4();
    let raw = forge_core::canonical::javascript_stringify(&state);
    sqlx::query("INSERT INTO product_state(id,workspace_id,owner_id,owner_user_id,key,encoded_value,revision) VALUES($1,$2,$3,$4,$5,$6,1)").bind(id).bind(&a.workspace_id).bind(format!("user:{}",a.user_id)).bind(&a.user_id).bind(format!("forge:team-home:v1:{team}")).bind(serde_json::to_string(&raw).unwrap()).execute(&f.pool).await.unwrap();
    id
}
async fn copy_state(f: &Fixture, id: Uuid) -> Value {
    let encoded: String = sqlx::query_scalar("SELECT encoded_value FROM product_state WHERE id=$1")
        .bind(id)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    let raw: String = serde_json::from_str(&encoded).unwrap();
    forge_core::json::parse(&raw).unwrap()
}
fn legacy(id: Uuid) -> Value {
    let mut v = fields("Document");
    v["id"] = json!(id);
    v["kind"] = json!("document");
    v["content"] = json!("Document");
    v
}

#[tokio::test]
async fn legacy_team_import_consumes_only_reviewed_author_copy_and_retains_other_writing() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let id = Uuid::new_v4();
    let copy = legacy(id);
    let unrelated = json!({"kind":"link","id":Uuid::new_v4(),"url":"https://example.test"});
    let state = json!({"resources":[copy,unrelated],"retainedDocumentDrafts":[{"raw":"Keep me"}],"favorite":true});
    let state_id = seed_copy(&f, &f.actor, team, state.clone()).await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let other_id=seed_copy(&f,&member,team,json!({"resources":[{ "id":id,"kind":"document","title":"Other author's draft","body":{"type":"unsafe"}}]})).await;
    let input = creation(id, json!({"kind":"team","id":team}));
    assert_eq!(
        command(&f, &f.actor, input.clone()).await.unwrap()["status"],
        "conflict"
    );
    assert_eq!(copy_state(&f, state_id).await, state);
    let mut reviewed = input;
    reviewed["legacyImport"] = json!(true);
    let mut stale = reviewed.clone();
    stale["fields"] = fields("Stale");
    assert_eq!(
        command(&f, &f.actor, stale).await.unwrap()["status"],
        "conflict"
    );
    assert_eq!(counts(&f, id).await, (0, 0, 0, 0));
    assert_eq!(
        command(&f, &f.actor, reviewed).await.unwrap()["status"],
        "saved"
    );
    let after = copy_state(&f, state_id).await;
    assert_eq!(after["resources"], json!([unrelated]));
    assert_eq!(
        after["retainedDocumentDrafts"],
        state["retainedDocumentDrafts"]
    );
    assert_eq!(
        copy_state(&f, other_id).await["resources"][0]["title"],
        "Other author's draft"
    );
    let mut tx = f.database.begin().await.unwrap();
    let raw = forge_core::canonical::javascript_stringify(&copy_state(&f, other_id).await);
    let recovered = documents::prune_team_copies(
        &mut tx,
        &member,
        &format!("forge:team-home:v1:{team}"),
        Some(&raw),
        None,
    )
    .await
    .unwrap()
    .unwrap();
    tx.commit().await.unwrap();
    let recovered: Value = serde_json::from_str(&recovered).unwrap();
    assert_eq!(recovered["resources"], json!([]));
    assert_eq!(
        recovered["retainedDocumentDrafts"][0]["body"],
        json!({"type":"unsafe"})
    );
    command(
        &f,
        &f.actor,
        json!({"action":"delete","id":id,"expectedRevision":1}),
    )
    .await
    .unwrap();
    let mut tx = f.database.begin().await.unwrap();
    let recovered = documents::prune_team_copies(
        &mut tx,
        &member,
        &format!("forge:team-home:v1:{team}"),
        Some(&raw),
        None,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&recovered).unwrap()["resources"],
        json!([])
    );
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn legacy_import_requires_a_present_exact_snapshot_and_divergent_duplicates_conflict() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let id = Uuid::new_v4();
    let mut input = creation(id, json!({"kind":"team","id":team}));
    input["legacyImport"] = json!(true);
    assert_eq!(
        command(&f, &f.actor, input.clone()).await.unwrap()["status"],
        "conflict"
    );
    let copy = legacy(id);
    let mut divergent = copy.clone();
    divergent["content"] = json!("Plain text draft changed");
    let raw = json!({"resources":[copy,divergent]});
    let state = seed_copy(&f, &f.actor, team, raw.clone()).await;
    assert_eq!(
        command(&f, &f.actor, input).await.unwrap()["status"],
        "conflict"
    );
    assert_eq!(counts(&f, id).await, (0, 0, 0, 0));
    assert_eq!(copy_state(&f, state).await, raw);
    let mut workspace = creation(Uuid::new_v4(), json!({"kind":"workspace"}));
    workspace["legacyImport"] = json!(true);
    assert_eq!(
        command(&f, &f.actor, workspace).await.unwrap()["status"],
        "conflict"
    );
}

#[tokio::test]
async fn project_legacy_imports_preserve_links_and_issue_sources_follow_active_visibility() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let project = Uuid::new_v4();
    let id = Uuid::new_v4();
    projects::save(
        &f.database,
        &f.actor,
        &Uuid::new_v4().to_string(),
        json!([{"id":project,"expectedRevision":null,"changes":{"name":"Docs","teamIds":[team]}}]),
    )
    .await
    .unwrap();
    let link = json!({"id":Uuid::new_v4(),"title":"Link","url":"https://example.test"});
    let mut body = json!({"type":"paragraph"});
    for _ in 1..64 {
        body = json!({"type":"blockquote","content":[body]});
    }
    body = json!({"type":"doc","content":[body]});
    let mut copy = legacy(id);
    copy["id"] = json!(id.to_string().to_uppercase());
    copy["body"] = body.clone();
    copy.as_object_mut().unwrap().remove("kind");
    sqlx::query(
        "UPDATE projects SET properties=jsonb_set(properties,'{resources}',$1) WHERE id=$2",
    )
    .bind(json!([copy, link]))
    .bind(project)
    .execute(&f.pool)
    .await
    .unwrap();
    let mut input = creation(id, json!({"kind":"project","id":project}));
    input["id"] = json!(id.to_string().to_uppercase());
    input["fields"]["body"] = body;
    assert_eq!(
        command(&f, &f.actor, input.clone()).await.unwrap()["status"],
        "conflict"
    );
    input["legacyImport"] = json!(true);
    let saved = command(&f, &f.actor, input).await.unwrap();
    assert_eq!(saved["id"], id.to_string().to_uppercase());
    let remaining: Value =
        sqlx::query_scalar("SELECT properties->'resources' FROM projects WHERE id=$1")
            .bind(project)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(remaining, json!([link]));
    let issue = create(&f, team, "Issue source").await;
    let child = Uuid::new_v4();
    command(
        &f,
        &f.actor,
        creation(child, json!({"kind":"issue","id":issue["id"]})),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE issues SET archived_at=now() WHERE id=$1")
        .bind(issue["id"].as_str().unwrap().parse::<Uuid>().unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(read(&f, &f.actor, child).await.is_err());
    assert!(
        command(
            &f,
            &f.actor,
            creation(Uuid::new_v4(), json!({"kind":"issue","id":issue["id"]}))
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn deepest_supported_document_survives_storage_reads_planning_and_history() {
    let f = Fixture::new().await;
    let id = Uuid::new_v4();
    let mut body = json!({"type":"paragraph"});
    for _ in 1..64 {
        body = json!({"type":"blockquote","content":[body]});
    }
    body = json!({"type":"doc","content":[body]});
    let mut input = creation(id, json!({"kind":"workspace"}));
    input["fields"]["body"] = body.clone();
    command(&f, &f.actor, input).await.unwrap();
    assert_eq!(read(&f, &f.actor, id).await.unwrap()["body"], body);
    assert_eq!(
        planning::get(&f.database, &f.actor, Resource::Document, id)
            .await
            .unwrap()["body"],
        body
    );
    assert_eq!(
        documents::history(&f.database, &f.actor, id, None, OPTIONS)
            .await
            .unwrap()[0]["body"],
        body
    );
    command(
        &f,
        &f.actor,
        json!({"action":"restore","id":id,"expectedRevision":1,"revision":1}),
    )
    .await
    .unwrap();
}
