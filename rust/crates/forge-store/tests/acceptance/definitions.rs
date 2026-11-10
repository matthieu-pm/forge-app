use super::{Fixture, enter_workspace, team_input};
use forge_core::{
    actor::{Actor, ApiScope, Authentication},
    definitions::DefinitionValue,
};
use forge_store::{
    StoreError,
    definitions::{self, Classification, DefinitionCommand, DefinitionSnapshot},
    teams,
};
use serde_json::{Value, json};
use uuid::Uuid;

#[tokio::test]
async fn corrupt_definition_and_classification_receipts_never_repeat_the_effect() {
    let f = Fixture::new().await;
    let snapshot = ready(&f, 1).await;
    let name = format!("malformed_completion_{}", Uuid::new_v4().simple());
    // Simulate a faulty historical writer at its original completion. The
    // immutable-receipt and atomic-audit guards remain enabled throughout.
    sqlx::raw_sql(&format!("CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.response_body:='{{}}'; RETURN NEW; END $$; CREATE TRIGGER {name} BEFORE UPDATE ON command_receipts FOR EACH ROW WHEN (OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL AND NEW.workspace_id='{}') EXECUTE FUNCTION {name}();",f.actor.workspace_id)).execute(&f.pool).await.unwrap();
    let input = command(&f.actor, &snapshot, snapshot.value.as_value().clone());
    definitions::save(&f.database, &f.actor, &input)
        .await
        .unwrap();
    assert!(matches!(
        definitions::save(&f.database, &f.actor, &input).await,
        Err(StoreError::CommandResultUnavailable)
    ));
    assert_eq!(
        definitions::read(&f.database, &f.actor, snapshot.team_id)
            .await
            .unwrap()
            .revision,
        2
    );
    let id = issue(&f, snapshot.team_id.unwrap(), "ready").await;
    let input = classify(id, "ready", "todo", vec![]);
    definitions::classify(&f.database, &f.actor, &input)
        .await
        .unwrap();
    sqlx::raw_sql(&format!(
        "DROP TRIGGER {name} ON command_receipts; DROP FUNCTION {name}();"
    ))
    .execute(&f.pool)
    .await
    .unwrap();
    assert!(matches!(
        definitions::classify(&f.database, &f.actor, &input).await,
        Err(StoreError::CommandResultUnavailable)
    ));
    assert_eq!(status(&f, id).await, "todo");
}

fn label(name: &str) -> Value {
    json!({"id":Uuid::new_v4(),"name":name,"description":"","color":"#5e6ad2","groupId":null,"issues":900,"lastApplied":"2026-11-01T00:00:00.000Z","createdAt":"2026-11-01T00:00:00.000Z"})
}
fn command(actor: &Actor, snapshot: &DefinitionSnapshot, value: Value) -> DefinitionCommand {
    let Authentication::Session { session_id } = &actor.authentication else {
        panic!("session fixture")
    };
    serde_json::from_value(json!({"workspaceId":actor.workspace_id,"sessionId":session_id,"teamId":snapshot.team_id,"commandKey":Uuid::new_v4().to_string(),"expectedRevision":snapshot.revision,"value":value})).unwrap()
}
async fn ready(f: &Fixture, n: u32) -> DefinitionSnapshot {
    let team = teams::create(&f.database, &f.actor, &team_input(n))
        .await
        .unwrap();
    let snapshot = definitions::read(&f.database, &f.actor, Some(team.id))
        .await
        .unwrap();
    let mut value = snapshot.value.as_value().clone();
    value["statuses"]["statuses"].as_array_mut().unwrap().push(json!({"id":"ready","name":"Ready","group":"unstarted","description":"Ready to start","color":"#aabbcc"}));
    definitions::save(&f.database, &f.actor, &command(&f.actor, &snapshot, value))
        .await
        .unwrap()
}
async fn issue(f: &Fixture, team: Uuid, status: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO issues(id,workspace_id,team_id,number,title,status_id) SELECT $1,$2,$3,coalesce(max(number),0)+1,'Acceptance issue',$4 FROM issues WHERE team_id=$3")
        .bind(id).bind(&f.actor.workspace_id).bind(team).bind(status).execute(&f.pool).await.unwrap();
    id
}
async fn status(f: &Fixture, id: Uuid) -> String {
    sqlx::query_scalar("SELECT status_id FROM issues WHERE id=$1")
        .bind(id)
        .fetch_one(&f.pool)
        .await
        .unwrap()
}
fn classify(issue_id: Uuid, from: &str, to: &str, label_ids: Vec<Uuid>) -> Classification {
    Classification {
        issue_id,
        command_key: Uuid::new_v4().to_string(),
        expected_status_id: from.into(),
        status_id: to.into(),
        label_ids,
    }
}
fn remove_ready(value: &mut Value) {
    value["statuses"]["statuses"]
        .as_array_mut()
        .unwrap()
        .retain(|s| s["id"] != "ready");
}

#[tokio::test]
async fn definitions_reload_canonical_counts_and_receipts_recheck_live_authority() {
    let f = Fixture::new().await;
    let snapshot = ready(&f, 1).await;
    let mut value = snapshot.value.as_value().clone();
    let mobile = label("Mobile");
    value["labels"]["labels"] = json!([mobile]);
    let input = command(&f.actor, &snapshot, value);
    let saved = definitions::save(&f.database, &f.actor, &input)
        .await
        .unwrap();
    assert_eq!(saved.revision, 2);
    assert_eq!(saved.value.labels()[0]["issues"], 0);
    assert_eq!(saved.value.labels()[0]["lastApplied"], Value::Null);
    let issue = issue(&f, snapshot.team_id.unwrap(), "ready").await;
    definitions::classify(
        &f.database,
        &f.actor,
        &classify(
            issue,
            "ready",
            "ready",
            vec![Uuid::parse_str(mobile["id"].as_str().unwrap()).unwrap()],
        ),
    )
    .await
    .unwrap();
    let replay = definitions::save(&f.database, &f.actor, &input)
        .await
        .unwrap();
    assert_eq!(replay.revision, 2);
    assert_eq!(replay.value.labels()[0]["issues"], 1);
    let mut changed = input.clone();
    changed.expected_revision += 1;
    assert!(matches!(
        definitions::save(&f.database, &f.actor, &changed).await,
        Err(StoreError::CommandReused)
    ));
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        definitions::save(&f.database, &f.actor, &input).await,
        Err(StoreError::Forbidden)
    ));
    let read = definitions::read(&f.database, &f.actor, snapshot.team_id)
        .await
        .unwrap();
    assert!(!read.can_manage);
    let audits:i64=sqlx::query_scalar("SELECT count(*) FROM command_audit_events WHERE workspace_id=$1 AND operation='issueDefinitions.save@1'").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(audits, 2);
}

#[tokio::test]
async fn assigned_status_and_label_replacements_are_atomic_and_deduplicate() {
    let f = Fixture::new().await;
    let snapshot = ready(&f, 1).await;
    let mut value = snapshot.value.as_value().clone();
    let old = label("Old");
    let target = label("Target");
    value["labels"]["labels"] = json!([old, target]);
    let snapshot = definitions::save(&f.database, &f.actor, &command(&f.actor, &snapshot, value))
        .await
        .unwrap();
    let issue = issue(&f, snapshot.team_id.unwrap(), "ready").await;
    let old_id = Uuid::parse_str(old["id"].as_str().unwrap()).unwrap();
    let target_id = Uuid::parse_str(target["id"].as_str().unwrap()).unwrap();
    definitions::classify(
        &f.database,
        &f.actor,
        &classify(issue, "ready", "ready", vec![old_id, target_id]),
    )
    .await
    .unwrap();
    let mut value = snapshot.value.as_value().clone();
    remove_ready(&mut value);
    value["labels"]["labels"] = json!([target]);
    let mut input = command(&f.actor, &snapshot, value);
    assert!(matches!(
        definitions::save(&f.database, &f.actor, &input).await,
        Err(StoreError::DefinitionConflict(_))
    ));
    input
        .status_replacements
        .insert("ready".into(), "todo".into());
    assert!(matches!(
        definitions::save(&f.database, &f.actor, &input).await,
        Err(StoreError::DefinitionConflict(_))
    ));
    assert_eq!(status(&f, issue).await, "ready");
    assert_eq!(
        definitions::read(&f.database, &f.actor, snapshot.team_id)
            .await
            .unwrap()
            .revision,
        2
    );
    input
        .label_replacements
        .insert(old_id.to_string(), target_id.to_string());
    let saved = definitions::save(&f.database, &f.actor, &input)
        .await
        .unwrap();
    assert_eq!(saved.revision, 3);
    assert_eq!(status(&f, issue).await, "todo");
    let labels: Vec<Uuid> =
        sqlx::query_scalar("SELECT label_id FROM issue_labels WHERE issue_id=$1")
            .bind(issue)
            .fetch_all(&f.pool)
            .await
            .unwrap();
    assert_eq!(labels, vec![target_id]);
    assert_eq!(saved.value.labels()[0]["issues"], 1);
}

#[tokio::test]
async fn competing_definition_revisions_cannot_overwrite_each_other() {
    let f = Fixture::new().await;
    let snapshot = ready(&f, 1).await;
    let mut value = snapshot.value.as_value().clone();
    value["statuses"]["defaultId"] = json!("ready");
    let first = command(&f.actor, &snapshot, value);
    let second = command(&f.actor, &snapshot, snapshot.value.as_value().clone());
    let (a, b) = tokio::join!(
        definitions::save(&f.database, &f.actor, &first),
        definitions::save(&f.database, &f.actor, &second)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert!(
        matches!(a, Err(StoreError::DefinitionConflict(_)))
            || matches!(b, Err(StoreError::DefinitionConflict(_)))
    );
    assert_eq!(
        definitions::read(&f.database, &f.actor, snapshot.team_id)
            .await
            .unwrap()
            .revision,
        2
    );
}

#[tokio::test]
async fn definitions_enforce_session_binding_private_visibility_and_live_issue_scopes() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let private = ready(&f, 1).await;
    let public = ready(&f, 2).await;
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(private.team_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        definitions::read(&f.database, &member, private.team_id).await,
        Err(StoreError::Forbidden)
    ));
    let all = definitions::read_all(&f.database, &member).await.unwrap();
    assert_eq!(all["snapshots"].as_array().unwrap().len(), 2);
    let mut forged = member.clone();
    forged.workspace_role = "owner".into();
    assert!(matches!(
        definitions::save(
            &f.database,
            &forged,
            &command(&forged, &public, public.value.as_value().clone())
        )
        .await,
        Err(StoreError::Forbidden)
    ));
    let mut input = command(&f.actor, &public, public.value.as_value().clone());
    input.session_id = "different".into();
    assert!(matches!(
        definitions::save(&f.database, &f.actor, &input).await,
        Err(StoreError::Forbidden)
    ));
    input = command(&f.actor, &public, public.value.as_value().clone());
    input.workspace_id = other.actor.workspace_id.clone();
    assert!(matches!(
        definitions::save(&f.database, &f.actor, &input).await,
        Err(StoreError::Forbidden)
    ));
    let key = forge_store::api_keys::create(
        &f.database,
        &f.actor,
        &forge_store::api_keys::CreateKey {
            name: "Issues only".into(),
            expires_in_days: 90,
            scopes: vec![ApiScope::IssuesRead],
        },
    )
    .await
    .unwrap();
    let actor = forge_store::authority::api_key_actor(&f.database, key["key"].as_str().unwrap())
        .await
        .unwrap();
    assert!(!actor.has_scope(ApiScope::TeamsRead));
    assert!(
        !definitions::read(&f.database, &actor, private.team_id)
            .await
            .unwrap()
            .can_manage
    );
    let issue = issue(&f, public.team_id.unwrap(), "ready").await;
    assert!(matches!(
        definitions::classify(
            &f.database,
            &actor,
            &classify(issue, "ready", "todo", vec![])
        )
        .await,
        Err(StoreError::Forbidden)
    ));
    let key = forge_store::api_keys::create(
        &f.database,
        &f.actor,
        &forge_store::api_keys::CreateKey {
            name: "Teams only".into(),
            expires_in_days: 90,
            scopes: vec![ApiScope::TeamsRead],
        },
    )
    .await
    .unwrap();
    let actor = forge_store::authority::api_key_actor(&f.database, key["key"].as_str().unwrap())
        .await
        .unwrap();
    assert!(matches!(
        definitions::read(&f.database, &actor, public.team_id).await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn workspace_label_counts_exclude_private_and_archived_issues() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let private = ready(&f, 1).await;
    let public = ready(&f, 2).await;
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(private.team_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let shared = definitions::read(&f.database, &f.actor, None)
        .await
        .unwrap();
    let mut value = shared.value.as_value().clone();
    let l = label("Shared");
    value["labels"]["labels"] = json!([l]);
    definitions::save(&f.database, &f.actor, &command(&f.actor, &shared, value))
        .await
        .unwrap();
    let label_id = Uuid::parse_str(l["id"].as_str().unwrap()).unwrap();
    for team in [public.team_id, private.team_id] {
        let issue = issue(&f, team.unwrap(), "ready").await;
        definitions::classify(
            &f.database,
            &f.actor,
            &classify(issue, "ready", "ready", vec![label_id]),
        )
        .await
        .unwrap();
    }
    assert_eq!(
        definitions::read(&f.database, &f.actor, None)
            .await
            .unwrap()
            .value
            .labels()[0]["issues"],
        2
    );
    assert_eq!(
        definitions::read(&f.database, &member, None)
            .await
            .unwrap()
            .value
            .labels()[0]["issues"],
        1
    );
    sqlx::query("UPDATE issues SET archived_at=now() WHERE team_id=$1")
        .bind(public.team_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        definitions::read(&f.database, &member, None)
            .await
            .unwrap()
            .value
            .labels()[0]["issues"],
        0
    );
}

#[tokio::test]
async fn classification_enforces_transitions_expected_status_and_archived_label_retention() {
    let f = Fixture::new().await;
    let snapshot = ready(&f, 1).await;
    let team = snapshot.team_id.unwrap();
    let mut value = snapshot.value.as_value().clone();
    let l = label("Existing");
    value["labels"]["labels"] = json!([l]);
    value["transitions"] = json!({"backlog":["todo"]});
    let snapshot = definitions::save(&f.database, &f.actor, &command(&f.actor, &snapshot, value))
        .await
        .unwrap();
    let id = issue(&f, team, "backlog").await;
    let label_id = Uuid::parse_str(l["id"].as_str().unwrap()).unwrap();
    definitions::classify(
        &f.database,
        &f.actor,
        &classify(id, "backlog", "backlog", vec![label_id]),
    )
    .await
    .unwrap();
    let mut value = snapshot.value.as_value().clone();
    value["labels"]["labels"][0]["archived"] = json!(true);
    definitions::save(&f.database, &f.actor, &command(&f.actor, &snapshot, value))
        .await
        .unwrap();
    assert!(
        definitions::classify(
            &f.database,
            &f.actor,
            &classify(id, "backlog", "done", vec![label_id])
        )
        .await
        .is_err()
    );
    let error = sqlx::query("UPDATE issues SET status_id='done' WHERE id=$1")
        .bind(id)
        .execute(&f.pool)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().constraint(),
        Some("issues_allowed_transition")
    );
    let input = classify(id, "backlog", "todo", vec![label_id]);
    definitions::classify(&f.database, &f.actor, &input)
        .await
        .unwrap();
    definitions::classify(&f.database, &f.actor, &input)
        .await
        .unwrap();
    assert!(matches!(
        definitions::classify(
            &f.database,
            &f.actor,
            &classify(id, "backlog", "todo", vec![])
        )
        .await,
        Err(StoreError::DefinitionConflict(_))
    ));
    let fresh = issue(&f, team, "backlog").await;
    assert!(
        definitions::classify(
            &f.database,
            &f.actor,
            &classify(fresh, "backlog", "todo", vec![label_id])
        )
        .await
        .is_err()
    );
    assert_eq!(status(&f, fresh).await, "backlog");
    definitions::classify(
        &f.database,
        &f.actor,
        &classify(id, "todo", "done", vec![label_id]),
    )
    .await
    .unwrap();
}

fn template(team: Uuid, status: &str, labels: Vec<Value>) -> Value {
    json!({"kind":"issue","name":"Saved","properties":{"teamIds":[team],"status":status,"labels":labels},"issues":[],"subIssues":[]})
}
async fn insert_template(f: &Fixture, team: Uuid, payload: &Value) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO team_templates(workspace_id,team_id,payload,created_by_user_id) VALUES($1,$2,$3,$4)").bind(&f.actor.workspace_id).bind(team).bind(payload).bind(&f.actor.user_id).execute(&f.pool).await.map(|_|())
}

#[tokio::test]
async fn saved_templates_and_recurring_references_prevent_destructive_definition_changes() {
    let f = Fixture::new().await;
    let snapshot = ready(&f, 1).await;
    let team = snapshot.team_id.unwrap();
    let l = label("Saved label");
    let mut value = snapshot.value.as_value().clone();
    value["labels"]["labels"] = json!([l]);
    let snapshot = definitions::save(&f.database, &f.actor, &command(&f.actor, &snapshot, value))
        .await
        .unwrap();
    insert_template(&f, team, &template(team, "Ready", vec![l["id"].clone()]))
        .await
        .unwrap();
    sqlx::query("INSERT INTO team_recurring_issues(workspace_id,team_id,payload,created_by_user_id) VALUES($1,$2,$3,$4)").bind(&f.actor.workspace_id).bind(team).bind(template(team,"ready",vec![])).bind(&f.actor.user_id).execute(&f.pool).await.unwrap();
    for field in ["status", "label", "name"] {
        let mut value = snapshot.value.as_value().clone();
        match field {
            "status" => remove_ready(&mut value),
            "label" => value["labels"]["labels"] = json!([]),
            _ => {
                let s = value["statuses"]["statuses"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|s| s["id"] == "ready")
                    .unwrap();
                s["name"] = json!("Renamed");
            }
        }
        let input = command(&f.actor, &snapshot, value);
        assert!(matches!(
            definitions::save(&f.database, &f.actor, &input).await,
            Err(StoreError::DefinitionConflict(_))
        ));
    }
    assert!(
        insert_template(&f, team, &template(team, "missing", vec![]))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn template_creation_and_status_removal_serialize_without_dangling_references() {
    let f = Fixture::new().await;
    let snapshot = ready(&f, 1).await;
    let team = snapshot.team_id.unwrap();
    let mut value = snapshot.value.as_value().clone();
    remove_ready(&mut value);
    let input = command(&f.actor, &snapshot, value);
    let payload = template(team, "Ready", vec![]);
    let (a, b) = tokio::join!(
        definitions::save(&f.database, &f.actor, &input),
        insert_template(&f, team, &payload)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
}

#[tokio::test]
async fn failed_audit_rolls_back_definition_and_receipt_before_retry() {
    let f = Fixture::new().await;
    let snapshot = ready(&f, 1).await;
    let mut value = snapshot.value.as_value().clone();
    value["statuses"]["defaultId"] = json!("ready");
    let input = command(&f.actor, &snapshot, value);
    let name = format!("reject_definition_{}", Uuid::new_v4().simple());
    // A workspace-specific trigger leaves concurrently running fixtures alone.
    sqlx::raw_sql(&format!("CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$; CREATE TRIGGER {name} BEFORE INSERT ON command_audit_events FOR EACH ROW WHEN (NEW.workspace_id='{}') EXECUTE FUNCTION {name}();",f.actor.workspace_id)).execute(&f.pool).await.unwrap();
    let result = definitions::save(&f.database, &f.actor, &input).await;
    sqlx::raw_sql(&format!(
        "DROP TRIGGER {name} ON command_audit_events; DROP FUNCTION {name}();"
    ))
    .execute(&f.pool)
    .await
    .unwrap();
    assert!(result.is_err());
    assert_eq!(
        definitions::read(&f.database, &f.actor, snapshot.team_id)
            .await
            .unwrap()
            .revision,
        1
    );
    let receipts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM command_receipts WHERE workspace_id=$1 AND command_key=$2",
    )
    .bind(&f.actor.workspace_id)
    .bind(&input.command_key)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert_eq!(receipts, 0);
    assert_eq!(
        definitions::save(&f.database, &f.actor, &input)
            .await
            .unwrap()
            .revision,
        2
    );
}

#[tokio::test]
async fn foreign_label_ids_cannot_be_rebound_and_invalid_metadata_is_not_silently_repaired() {
    let f = Fixture::new().await;
    let a = ready(&f, 1).await;
    let b = ready(&f, 2).await;
    let l = label("Scoped label");
    let mut value = a.value.as_value().clone();
    value["labels"]["labels"] = json!([l]);
    definitions::save(&f.database, &f.actor, &command(&f.actor, &a, value))
        .await
        .unwrap();
    let mut value = b.value.as_value().clone();
    value["labels"]["labels"] = json!([l]);
    assert!(matches!(
        definitions::save(&f.database, &f.actor, &command(&f.actor, &b, value)).await,
        Err(StoreError::Forbidden)
    ));
    let label_id = Uuid::parse_str(l["id"].as_str().unwrap()).unwrap();
    let issue = issue(&f, b.team_id.unwrap(), "ready").await;
    assert!(
        definitions::classify(
            &f.database,
            &f.actor,
            &classify(issue, "ready", "todo", vec![label_id])
        )
        .await
        .is_err()
    );
    sqlx::query("UPDATE resource_labels SET definition=jsonb_set(definition,'{color}','42'::jsonb) WHERE id=$1").bind(label_id).execute(&f.pool).await.unwrap();
    assert!(matches!(
        definitions::read(&f.database, &f.actor, a.team_id).await,
        Err(StoreError::InvalidInput)
    ));
    assert!(DefinitionValue::parse(json!({})).is_err());
}
