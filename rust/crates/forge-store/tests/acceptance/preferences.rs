use super::{Fixture, enter_workspace};
use forge_core::{
    actor::{Actor, Authentication},
    preferences::imports as contract,
};
use forge_store::{
    StoreError,
    preferences::{self as p, PreferenceOptions, imports},
};
use serde_json::{Value, json};
use uuid::Uuid;
const OPTIONS: PreferenceOptions = PreferenceOptions {
    enabled: true,
    names: true,
    import_enabled: true,
    agent_guidance: false,
};
fn session(a: &Actor) -> &str {
    match &a.authentication {
        Authentication::Session { session_id } => session_id,
        _ => "external",
    }
}
fn input(a: &Actor, patch: Value) -> Value {
    let versions: serde_json::Map<String, Value> = patch
        .as_object()
        .unwrap()
        .keys()
        .map(|k| (k.clone(), json!(0)))
        .collect();
    json!({"sessionId":session(a),"commandKey":Uuid::new_v4(),"version":1,"patch":patch,"expectedVersions":versions})
}
fn identity(a: &Actor) -> Value {
    json!({"userId":a.user_id,"workspaceId":a.workspace_id,"sessionId":session(a)})
}
async fn snapshot(f: &Fixture, a: &Actor) -> Value {
    p::read(&f.database, a, "account", OPTIONS).await.unwrap()
}
async fn plan(f: &Fixture, raw: &str) -> Value {
    let source = json!({"location":"local","key":"forge.personal-preferences","raw":raw});
    let inspected = contract::inspect(&source, &f.actor.user_id);
    let choices: serde_json::Map<String, Value> = inspected["fields"]
        .as_object()
        .unwrap()
        .keys()
        .map(|k| (k.clone(), json!("import")))
        .collect();
    json!({"id":Uuid::new_v4(),"identity":identity(&f.actor),"source":source,"fingerprint":contract::fingerprint(&source),"ownershipConfirmed":true,"snapshot":snapshot(f,&f.actor).await,"choices":choices})
}
async fn step(f: &Fixture, plan: &Value, path: &str) -> Result<Value, StoreError> {
    imports::apply(&f.database,&f.actor,json!({"identity":identity(&f.actor),"id":plan["id"],"fingerprint":plan["fingerprint"],"path":path}),OPTIONS).await
}
#[tokio::test]
async fn preference_fields_merge_concurrently_and_conflicting_patches_leave_no_receipt() {
    let f = Fixture::new().await;
    let a = input(&f.actor, json!({"general.interfaceTheme":"dark"}));
    let b = input(&f.actor, json!({"general.fontSize":"large"}));
    let (x, y) = tokio::join!(
        p::patch(&f.database, &f.actor, a.clone(), OPTIONS),
        p::patch(&f.database, &f.actor, b, OPTIONS)
    );
    assert_eq!(x.unwrap()["status"], "saved");
    assert_eq!(y.unwrap()["status"], "saved");
    let saved = snapshot(&f, &f.actor).await;
    assert_eq!(saved["revision"], 2);
    assert_eq!(saved["values"]["general.interfaceTheme"], "dark");
    assert_eq!(saved["values"]["general.fontSize"], "large");
    assert_eq!(
        p::patch(&f.database, &f.actor, a.clone(), OPTIONS)
            .await
            .unwrap()["snapshot"]["revision"],
        2
    );
    let conflict = input(
        &f.actor,
        json!({"general.interfaceTheme":"light","general.pointerCursors":true}),
    );
    let result = p::patch(&f.database, &f.actor, conflict.clone(), OPTIONS)
        .await
        .unwrap();
    assert_eq!(result["status"], "conflict");
    assert_eq!(result["fields"], json!(["general.interfaceTheme"]));
    assert!(
        result["snapshot"]["values"]
            .get("general.pointerCursors")
            .is_none()
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM command_receipts WHERE command_key=$1")
            .bind(conflict["commandKey"].as_str().unwrap())
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    let mut changed = a;
    changed["patch"]["general.interfaceTheme"] = json!("light");
    assert!(matches!(
        p::patch(&f.database, &f.actor, changed, OPTIONS).await,
        Err(StoreError::CommandReused)
    ));
}
#[tokio::test]
async fn preferences_are_owner_scoped_and_workspace_bound_with_current_authority() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let mut command = input(&member, json!({"teamHome.main.favorite":true}));
    command["scope"] = json!("workspace");
    command["expectedWorkspaceId"] = json!(&member.workspace_id);
    assert_eq!(
        p::patch(&f.database, &member, command.clone(), OPTIONS)
            .await
            .unwrap()["status"],
        "saved"
    );
    assert_eq!(
        p::read(&f.database, &f.actor, "workspace", OPTIONS)
            .await
            .unwrap()["values"],
        json!({})
    );
    assert_eq!(snapshot(&f, &member).await["values"], json!({}));
    let mut wrong = command.clone();
    wrong["expectedWorkspaceId"] = json!("different");
    assert!(matches!(
        p::patch(&f.database, &member, wrong, OPTIONS).await,
        Err(StoreError::Forbidden)
    ));
    let mut wrong = command.clone();
    wrong["sessionId"] = json!("different");
    assert!(matches!(
        p::patch(&f.database, &member, wrong, OPTIONS).await,
        Err(StoreError::Forbidden)
    ));
    sqlx::query("DELETE FROM member WHERE user_id=$1 AND organization_id=$2")
        .bind(&member.user_id)
        .bind(&member.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        p::patch(&f.database, &member, command, OPTIONS)
            .await
            .is_err()
    );
}
#[tokio::test]
async fn preference_gates_preserve_unavailable_guidance_and_directory_contains_only_members() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let unrelated = Fixture::new().await;
    assert!(
        p::read(
            &f.database,
            &f.actor,
            "account",
            PreferenceOptions::default()
        )
        .await
        .is_err()
    );
    let unavailable = p::patch(
        &f.database,
        &f.actor,
        input(
            &f.actor,
            json!({"agent.guidance":"Private writing","general.interfaceTheme":"dark"}),
        ),
        OPTIONS,
    )
    .await
    .unwrap();
    assert_eq!(unavailable["status"], "unavailable");
    assert_eq!(unavailable["snapshot"]["revision"], 0);
    let people = p::directory(
        &f.database,
        &f.actor,
        &f.actor.workspace_id,
        session(&f.actor),
        OPTIONS,
    )
    .await
    .unwrap();
    let people = people["people"].as_array().unwrap();
    assert_eq!(people.len(), 2);
    assert!(people.iter().any(|v| v["id"] == member.user_id));
    assert!(!people.iter().any(|v| v["id"] == unrelated.actor.user_id));
    assert!(people.iter().all(|v| v.get("email").is_none()));
    assert_eq!(
        p::directory(
            &f.database,
            &f.actor,
            &f.actor.workspace_id,
            session(&f.actor),
            PreferenceOptions::default()
        )
        .await
        .unwrap(),
        json!({"enabled":false,"people":[]})
    );
}
#[tokio::test]
async fn preference_import_reviews_each_field_preserves_source_and_detects_changed_baseline() {
    let f = Fixture::new().await;
    let plan = plan(
        &f,
        "{\"interfaceTheme\":\"dark\",\"fontSize\":\"large\",\"unknown\":\"Original bytes\"}",
    )
    .await;
    let prepared = imports::prepare(&f.database, &f.actor, plan.clone(), OPTIONS)
        .await
        .unwrap();
    assert_eq!(prepared["fields"]["general.fontSize"], "pending");
    p::patch(
        &f.database,
        &f.actor,
        input(&f.actor, json!({"general.fontSize":"small"})),
        OPTIONS,
    )
    .await
    .unwrap();
    assert_eq!(
        step(&f, &plan, "general.interfaceTheme").await.unwrap()["fields"]["general.interfaceTheme"],
        "saved"
    );
    assert_eq!(
        step(&f, &plan, "general.fontSize").await.unwrap()["fields"]["general.fontSize"],
        "conflict"
    );
    assert_eq!(
        step(&f, &plan, "general.interfaceTheme").await.unwrap()["fields"]["general.interfaceTheme"],
        "saved"
    );
    let saved = snapshot(&f, &f.actor).await;
    assert_eq!(saved["revision"], 2);
    assert_eq!(saved["values"]["general.fontSize"], "small");
    let stored:(Value,Value)=sqlx::query_as("SELECT i.manifest,c.source FROM personal_preference_imports i JOIN personal_preference_import_content c ON c.import_id=i.id WHERE i.id=$1").bind(plan["id"].as_str().unwrap().parse::<Uuid>().unwrap()).fetch_one(&f.pool).await.unwrap();
    assert_eq!(stored.1["raw"], plan["source"]["raw"]);
    assert!(stored.0["plan"]["source"].get("raw").is_none());
    assert!(stored.0["plan"]["snapshot"].get("values").is_none());
    let bodies:Vec<Option<String>>=sqlx::query_scalar("SELECT response_body FROM command_receipts WHERE workspace_id=$1 AND operation LIKE 'personalPreferenceImport.%'").bind(&f.actor.workspace_id).fetch_all(&f.pool).await.unwrap();
    assert!(
        bodies
            .iter()
            .flatten()
            .all(|s| !s.contains("Original bytes") && !s.contains("dark"))
    );
}
#[tokio::test]
async fn preference_import_saved_source_is_rechecked_even_on_receipt_replays() {
    let f = Fixture::new().await;
    let mut plan = plan(&f, "{\"interfaceTheme\":\"dark\"}").await;
    plan["source"]["location"] = json!("saved");
    plan["fingerprint"] = json!(contract::fingerprint(&plan["source"]));
    sqlx::query("INSERT INTO product_state(workspace_id,owner_id,owner_user_id,key,encoded_value) VALUES($1,$2,$3,$4,$5)").bind(&f.actor.workspace_id).bind(format!("user:{}",f.actor.user_id)).bind(&f.actor.user_id).bind(plan["source"]["key"].as_str().unwrap()).bind(serde_json::to_string(&plan["source"]["raw"]).unwrap()).execute(&f.pool).await.unwrap();
    imports::prepare(&f.database, &f.actor, plan.clone(), OPTIONS)
        .await
        .unwrap();
    step(&f, &plan, "general.interfaceTheme").await.unwrap();
    sqlx::query("UPDATE product_state SET encoded_value=$1 WHERE workspace_id=$2 AND key=$3")
        .bind("\"changed\"")
        .bind(&f.actor.workspace_id)
        .bind(plan["source"]["key"].as_str().unwrap())
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        imports::prepare(&f.database, &f.actor, plan.clone(), OPTIONS)
            .await
            .is_err()
    );
    assert!(step(&f, &plan, "general.interfaceTheme").await.is_err());
    let list = imports::load(&f.database, &f.actor, identity(&f.actor), OPTIONS)
        .await
        .unwrap();
    assert_eq!(
        list["manifests"][0]["plan"]["source"]["raw"],
        plan["source"]["raw"]
    );
}
#[tokio::test]
async fn preference_import_checks_unversioned_value_presence_and_cross_account_access() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let plan = plan(&f, "{\"interfaceTheme\":\"dark\"}").await;
    imports::prepare(&f.database, &f.actor, plan.clone(), OPTIONS)
        .await
        .unwrap();
    sqlx::query("UPDATE account_preferences SET values=$2 WHERE user_id=$1")
        .bind(&f.actor.user_id)
        .bind(json!({"general.interfaceTheme":"light"}))
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        step(&f, &plan, "general.interfaceTheme").await.unwrap()["fields"]["general.interfaceTheme"],
        "conflict"
    );
    let foreign = json!({"identity":identity(&member),"id":plan["id"],"fingerprint":plan["fingerprint"],"path":"general.interfaceTheme"});
    assert!(matches!(
        imports::apply(&f.database, &member, foreign, OPTIONS).await,
        Err(StoreError::Forbidden)
    ));
    assert!(
        imports::load(&f.database, &member, identity(&f.actor), OPTIONS)
            .await
            .is_err()
    );
    assert_eq!(
        imports::load(&f.database, &member, identity(&member), OPTIONS)
            .await
            .unwrap()["manifests"],
        json!([])
    );
}
#[tokio::test]
async fn concurrent_preference_changes_to_one_field_allow_one_commit() {
    let f = Fixture::new().await;
    let a = input(&f.actor, json!({"general.interfaceTheme":"dark"}));
    let b = input(&f.actor, json!({"general.interfaceTheme":"light"}));
    let (x, y) = tokio::join!(
        p::patch(&f.database, &f.actor, a, OPTIONS),
        p::patch(&f.database, &f.actor, b, OPTIONS)
    );
    let (x, y) = (x.unwrap(), y.unwrap());
    assert_ne!(x["status"], y["status"]);
    assert!([&x, &y].iter().any(|v| v["status"] == "conflict"));
    assert_eq!(snapshot(&f, &f.actor).await["revision"], 1);
}
#[tokio::test]
async fn preferences_keep_unknown_fields_and_refuse_future_storage_versions() {
    let f = Fixture::new().await;
    sqlx::query("UPDATE account_preferences SET values=$2 WHERE user_id=$1")
        .bind(&f.actor.user_id)
        .bind(json!({"future.setting":{"raw":"retained"}}))
        .execute(&f.pool)
        .await
        .unwrap();
    let command = input(&f.actor, json!({"general.interfaceTheme":"dark"}));
    p::patch(&f.database, &f.actor, command, OPTIONS)
        .await
        .unwrap();
    assert_eq!(
        snapshot(&f, &f.actor).await["values"]["future.setting"],
        json!({"raw":"retained"})
    );
    sqlx::query("UPDATE account_preferences SET version=2 WHERE user_id=$1")
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        p::patch(
            &f.database,
            &f.actor,
            input(&f.actor, json!({"general.fontSize":"large"})),
            OPTIONS
        )
        .await
        .is_err()
    );
    assert!(
        p::read(&f.database, &f.actor, "account", OPTIONS)
            .await
            .is_err()
    );
}
#[tokio::test]
async fn preference_audit_failure_rolls_back_values_and_receipts_before_retry() {
    let f = Fixture::new().await;
    let name = format!("preference_fail_{}", Uuid::new_v4().simple());
    let function = format!(
        "CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected preference audit failure'; END $$"
    );
    sqlx::query(&function).execute(&f.pool).await.unwrap();
    let trigger = format!(
        "CREATE TRIGGER {name} BEFORE INSERT ON command_audit_events FOR EACH ROW WHEN (NEW.actor_user_id = '{}') EXECUTE FUNCTION {name}()",
        f.actor.user_id.replace('\'', "''")
    );
    sqlx::query(&trigger).execute(&f.pool).await.unwrap();
    let command = input(&f.actor, json!({"calls.actionItems":false}));
    let failed = p::patch(&f.database, &f.actor, command.clone(), OPTIONS).await;
    sqlx::query(&format!("DROP TRIGGER {name} ON command_audit_events"))
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query(&format!("DROP FUNCTION {name}()"))
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(failed.is_err());
    assert_eq!(snapshot(&f, &f.actor).await["revision"], 0);
    assert_eq!(
        p::patch(&f.database, &f.actor, command, OPTIONS)
            .await
            .unwrap()["snapshot"]["revision"],
        1
    );
}
#[tokio::test]
async fn preference_import_does_not_treat_unknown_field_version_as_an_unset_field() {
    let f = Fixture::new().await;
    let plan = plan(&f, "{\"interfaceTheme\":\"dark\"}").await;
    imports::prepare(&f.database, &f.actor, plan.clone(), OPTIONS)
        .await
        .unwrap();
    sqlx::query("UPDATE account_preferences SET field_versions=$2 WHERE user_id=$1")
        .bind(&f.actor.user_id)
        .bind(json!({"general.interfaceTheme":"future-version"}))
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        step(&f, &plan, "general.interfaceTheme").await.unwrap()["fields"]["general.interfaceTheme"],
        "conflict"
    );
    let values: Value =
        sqlx::query_scalar("SELECT values FROM account_preferences WHERE user_id=$1")
            .bind(&f.actor.user_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(values.get("general.interfaceTheme").is_none());
}
#[tokio::test]
async fn malformed_preference_import_receipts_cannot_acknowledge_or_repeat_an_effect() {
    let f = Fixture::new().await;
    let plan = plan(&f, "{\"interfaceTheme\":\"dark\"}").await;
    imports::prepare(&f.database, &f.actor, plan.clone(), OPTIONS)
        .await
        .unwrap();
    // Seed imported evidence rather than mutating a terminal receipt, which the
    // source database correctly forbids. Audit/evidence still commit atomically.
    let path = "general.interfaceTheme";
    let durable = json!({"id":plan["id"],"path":path,"fingerprint":plan["fingerprint"]});
    let id = plan["id"].as_str().unwrap();
    let mut tx = f.pool.begin().await.unwrap();
    let receipt: Uuid = sqlx::query_scalar("INSERT INTO command_receipts(workspace_id,user_id,principal,operation,command_key,input_hash,response_body,response_status,resource_type,resource_id,completed_at) VALUES($1,$2,$3,'personalPreferenceImport.apply@1',$4,$5,$6,200,'personalPreferenceImport',$7,now()) RETURNING id")
        .bind(&f.actor.workspace_id).bind(&f.actor.user_id).bind(f.actor.command_principal())
        .bind(format!("{id}:{path}")).bind(forge_core::canonical::command_input_hash(&durable))
        .bind(r#"{"id":"not-a-uuid"}"#).bind(id).fetch_one(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO command_audit_events(workspace_id,command_id,actor_user_id,operation,resource_type,resource_id) VALUES($1,$2,$3,'personalPreferenceImport.apply@1','personalPreferenceImport',$4)")
        .bind(&f.actor.workspace_id).bind(receipt).bind(&f.actor.user_id).bind(id).execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    assert!(matches!(
        step(&f, &plan, path).await,
        Err(StoreError::CommandResultUnavailable)
    ));
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM personal_preference_imports WHERE user_id=$1")
            .bind(&f.actor.user_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
    assert_eq!(snapshot(&f, &f.actor).await["revision"], 0);
}
