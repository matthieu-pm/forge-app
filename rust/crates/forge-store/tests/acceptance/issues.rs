use super::{Fixture, enter_workspace, team_input};
use forge_core::{
    actor::ApiScope,
    comments::CommentCommand,
    issues::{CreateIssue, EditIssues},
};
use forge_store::{
    StoreError,
    issues::{self, IssueOptions},
    teams,
};
use serde_json::{Value, json};
use uuid::Uuid;
pub(super) async fn team(f: &Fixture, n: u32) -> Uuid {
    teams::create(&f.database, &f.actor, &team_input(n))
        .await
        .unwrap()
        .id
}
pub(super) fn create_input(team: Uuid, title: &str) -> Value {
    let mut draft = forge_core::issues::blank("todo");
    draft["title"] = json!(title);
    json!({"teamId":team,"commandKey":Uuid::new_v4().to_string(),"draft":draft})
}
pub(super) async fn create(f: &Fixture, team: Uuid, title: &str) -> Value {
    issues::create(
        &f.database,
        &f.actor,
        &CreateIssue::parse(create_input(team, title)).unwrap(),
        IssueOptions::default(),
    )
    .await
    .unwrap()["issue"]
        .clone()
}
fn issue_id(issue: &Value) -> Uuid {
    Uuid::parse_str(issue["id"].as_str().unwrap()).unwrap()
}
fn edit_input(team: Uuid, issue: &Value, changes: Value) -> EditIssues {
    EditIssues::parse(json!({"teamId":team,"commandKey":Uuid::new_v4(),"edits":[{"issueId":issue["id"],"expectedRevision":issue["revision"],"changes":changes}]})).unwrap()
}
async fn current(f: &Fixture, id: Uuid) -> Value {
    issues::read(&f.database, &f.actor, false).await.unwrap()["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["issue"]["id"] == id.to_string())
        .unwrap()["issue"]
        .clone()
}
fn document(text: &str) -> Value {
    json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]})
}
fn comment_input(team: Uuid, issue: &Value) -> Value {
    json!({"commandKey":Uuid::new_v4(),"teamId":team,"issueId":issue["id"],"commentId":Uuid::new_v4(),"action":"create","document":document("A useful comment")})
}

#[tokio::test]
async fn canonical_creation_replays_one_parent_children_and_attributable_history() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let mut input = create_input(team, "  Parent  ");
    input["draft"]["subIssues"] = json!([" First child ", "Second child"]);
    input["assigneeId"] = json!(f.actor.user_id);
    input["draft"]["favorite"] = json!(true);
    input["draft"]["subscribers"] = json!("forged");
    input["draft"]["activity"] =
        json!([{"id":"fake","author":"other","text":"forged attribution","createdAt":"anything"}]);
    let input = CreateIssue::parse(input).unwrap();
    let (a, b) = tokio::join!(
        issues::create(&f.database, &f.actor, &input, IssueOptions::default()),
        issues::create(&f.database, &f.actor, &input, IssueOptions::default())
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_ne!(a["replayed"], b["replayed"]);
    assert_eq!(a["value"], b["value"]);
    assert_eq!(a["records"].as_array().unwrap().len(), 3);
    assert_eq!(a["issue"]["title"], "Parent");
    assert_eq!(a["issue"]["number"], 1);
    assert_eq!(a["issue"]["favorite"], false);
    assert_eq!(a["issue"]["subscribers"], f.actor.user_id);
    assert_eq!(a["issue"]["activity"][0]["author"], f.actor.user_id);
    let rows: Vec<i32> =
        sqlx::query_scalar("SELECT number FROM issues WHERE team_id=$1 ORDER BY number")
            .bind(team)
            .fetch_all(&f.pool)
            .await
            .unwrap();
    assert_eq!(rows, vec![1, 2, 3]);
    let events:i64=sqlx::query_scalar("SELECT count(*) FROM command_outbox_events WHERE workspace_id=$1 AND topic='issue.created'").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(events, 3);
    let history = issues::history(&f.database, &f.actor, json!({"issueId":a["issue"]["id"]}))
        .await
        .unwrap();
    assert_eq!(history["entries"][0]["actor"]["userId"], f.actor.user_id);
    assert_eq!(history["entries"][0]["changes"][0]["field"], "assignee");
}

#[tokio::test]
async fn concurrent_creation_allocates_distinct_numbers_and_capacity_failure_rolls_back_children() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let a = CreateIssue::parse(create_input(team, "A")).unwrap();
    let b = CreateIssue::parse(create_input(team, "B")).unwrap();
    let (a, b) = tokio::join!(
        issues::create(&f.database, &f.actor, &a, IssueOptions::default()),
        issues::create(&f.database, &f.actor, &b, IssueOptions::default())
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_ne!(a["issue"]["number"], b["issue"]["number"]);
    sqlx::query("INSERT INTO issues(workspace_id,team_id,number,title,status_id) SELECT $1,$2,n,'Capacity fixture','todo' FROM generate_series(3,249) n").bind(&f.actor.workspace_id).bind(team).execute(&f.pool).await.unwrap();
    let mut input = create_input(team, "Must roll back");
    input["draft"]["subIssues"] = json!(["Child exceeds limit"]);
    let input = CreateIssue::parse(input).unwrap();
    assert!(
        issues::create(&f.database, &f.actor, &input, IssueOptions::default())
            .await
            .is_err()
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM issues WHERE team_id=$1")
        .bind(team)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 249);
    let last: i32 =
        sqlx::query_scalar("SELECT last_number FROM team_issue_numbers WHERE team_id=$1")
            .bind(team)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(last, 249);
    assert_eq!(create(&f, team, "Last admitted").await["number"], 250);
}

#[tokio::test]
async fn imported_issues_projects_cycles_and_fingerprints_remain_idempotent() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let mut raw = create_input(team, "Imported");
    raw["legacyId"] = json!("local-issue");
    raw["draft"]["project"] = json!("local-project");
    raw["draft"]["milestone"] = json!("Launch");
    raw["projectImport"] = json!({"id":"local-project","name":"Project","status":"Active","teamIds":[team],"health":"On track","milestones":[{"id":"m1","name":"Launch","completed":false}]});
    raw["draft"]["cycle"] = json!("2026-11-01");
    raw["cycleImport"] = json!({"startDate":"2026-11-01","endDate":"2026-11-14"});
    let first = issues::create(
        &f.database,
        &f.actor,
        &CreateIssue::parse(raw.clone()).unwrap(),
        IssueOptions::default(),
    )
    .await
    .unwrap();
    assert_eq!(first["issue"]["milestone"], "m1");
    assert!(Uuid::parse_str(first["issue"]["cycle"].as_str().unwrap()).is_ok());
    raw["commandKey"] = json!(Uuid::new_v4());
    let replay = issues::create(
        &f.database,
        &f.actor,
        &CreateIssue::parse(raw.clone()).unwrap(),
        IssueOptions::default(),
    )
    .await
    .unwrap();
    assert_eq!(first["issue"]["id"], replay["issue"]["id"]);
    raw["commandKey"] = json!(Uuid::new_v4());
    raw["draft"]["title"] = json!("Different source");
    assert!(matches!(
        issues::create(
            &f.database,
            &f.actor,
            &CreateIssue::parse(raw).unwrap(),
            IssueOptions::default()
        )
        .await,
        Err(StoreError::IssueValidation(_))
    ));
    let snapshot = issues::read(&f.database, &f.actor, true).await.unwrap();
    assert_eq!(snapshot["projects"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["cycles"].as_array().unwrap().len(), 1);
    assert_eq!(
        snapshot["projects"][0]["properties"]["creatorId"],
        f.actor.user_id
    );
}

#[tokio::test]
async fn batch_edit_conflicts_are_atomic_and_replay_reads_current_values() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let a = create(&f, team, "A").await;
    let b = create(&f, team, "B").await;
    let single = edit_input(team, &b, json!({"title":"B newer"}));
    issues::edit(&f.database, &f.actor, &single, IssueOptions::default())
        .await
        .unwrap();
    let batch=EditIssues::parse(json!({"teamId":team,"commandKey":Uuid::new_v4(),"edits":[{"issueId":a["id"],"expectedRevision":a["revision"],"changes":{"title":"A changed"}},{"issueId":b["id"],"expectedRevision":b["revision"],"changes":{"title":"B stale"}}]})).unwrap();
    let result = issues::edit(&f.database, &f.actor, &batch, IssueOptions::default())
        .await
        .unwrap();
    assert_eq!(result["status"], "conflict");
    assert_eq!(current(&f, issue_id(&a)).await["title"], "A");
    let input = edit_input(
        team,
        &a,
        json!({"title":"A saved","subIssues":["New child"]}),
    );
    let saved = issues::edit(&f.database, &f.actor, &input, IssueOptions::default())
        .await
        .unwrap();
    assert_eq!(saved["records"].as_array().unwrap().len(), 2);
    let replay = issues::edit(&f.database, &f.actor, &input, IssueOptions::default())
        .await
        .unwrap();
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["records"], saved["records"]);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM issues WHERE team_id=$1")
        .bind(team)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 3);
}

#[tokio::test]
async fn personal_assignment_distinguishes_omitted_null_children_and_started_status() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let options = IssueOptions {
        personal_preferences: true,
        assign_started: true,
    };
    sqlx::query("UPDATE account_preferences SET values=$1,version=1 WHERE user_id=$2")
        .bind(json!({"general.autoAssignToSelf":true,"general.assignStartedIssues":true}))
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let raw = create_input(team, "Omitted");
    let first = issues::create(
        &f.database,
        &f.actor,
        &CreateIssue::parse(raw).unwrap(),
        options,
    )
    .await
    .unwrap();
    assert_eq!(first["issue"]["assignee"], f.actor.user_id);
    let mut raw = create_input(team, "Unassigned");
    raw["assigneeId"] = Value::Null;
    raw["draft"]["subIssues"] = json!(["Independent child"]);
    let second = issues::create(
        &f.database,
        &f.actor,
        &CreateIssue::parse(raw).unwrap(),
        options,
    )
    .await
    .unwrap();
    assert_eq!(second["issue"]["assignee"], "");
    let child = second["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["issue"]["id"] != second["issue"]["id"])
        .unwrap();
    assert_eq!(child["issue"]["assignee"], f.actor.user_id);
    let changed = issues::edit(
        &f.database,
        &f.actor,
        &edit_input(team, &second["issue"], json!({"status":"in-progress"})),
        options,
    )
    .await
    .unwrap();
    assert_eq!(changed["records"][0]["issue"]["assignee"], f.actor.user_id);
    let mut raw = create_input(team, "Explicit stays empty");
    raw["assigneeId"] = Value::Null;
    let third = issues::create(
        &f.database,
        &f.actor,
        &CreateIssue::parse(raw).unwrap(),
        options,
    )
    .await
    .unwrap();
    let changed = issues::edit(
        &f.database,
        &f.actor,
        &edit_input(
            team,
            &third["issue"],
            json!({"status":"in-progress","assignee":""}),
        ),
        options,
    )
    .await
    .unwrap();
    assert_eq!(changed["records"][0]["issue"]["assignee"], "");
}

#[tokio::test]
async fn private_team_assignees_and_replay_are_checked_against_live_access() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let team = team(&f, 1).await;
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
    let mut raw = create_input(team, "Private");
    raw["assigneeId"] = json!(member.user_id);
    assert!(
        issues::create(
            &f.database,
            &f.actor,
            &CreateIssue::parse(raw).unwrap(),
            IssueOptions::default()
        )
        .await
        .is_err()
    );
    let input = CreateIssue::parse(create_input(team, "Private visible")).unwrap();
    assert!(matches!(
        issues::create(&f.database, &member, &input, IssueOptions::default()).await,
        Err(StoreError::Forbidden)
    ));
    let saved = issues::create(&f.database, &f.actor, &input, IssueOptions::default())
        .await
        .unwrap();
    let key = forge_store::api_keys::create(
        &f.database,
        &f.actor,
        &forge_store::api_keys::CreateKey {
            name: "Issue API".into(),
            expires_in_days: 90,
            scopes: vec![ApiScope::IssuesRead, ApiScope::IssuesWrite],
        },
    )
    .await
    .unwrap();
    let actor = forge_store::authority::api_key_actor(&f.database, key["key"].as_str().unwrap())
        .await
        .unwrap();
    assert!(!actor.has_scope(ApiScope::TeamsRead));
    assert_eq!(
        issues::read(&f.database, &actor, false).await.unwrap()["records"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    sqlx::query("UPDATE issues SET archived_at=now() WHERE id=$1")
        .bind(issue_id(&saved["issue"]))
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        issues::create(&f.database, &f.actor, &input, IssueOptions::default()).await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn discussion_versions_moderation_and_deleted_body_redaction_preserve_authority() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let team = team(&f, 1).await;
    let issue = create(&f, team, "Discussion").await;
    let mut raw = comment_input(team, &issue);
    let input = CommentCommand::parse(raw.clone()).unwrap();
    let saved = issues::comment(&f.database, &member, &input).await.unwrap();
    assert_eq!(saved["status"], "saved");
    assert_eq!(
        saved["records"][0]["issue"]["comments"][0]["author"],
        member.user_id
    );
    raw["commandKey"] = json!(Uuid::new_v4());
    raw["action"] = json!("edit");
    raw["document"] = document("Edited by moderator");
    let edited = issues::comment(
        &f.database,
        &f.actor,
        &CommentCommand::parse(raw.clone()).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(edited["records"][0]["issue"]["comments"][0]["version"], 1);
    raw["commandKey"] = json!(Uuid::new_v4());
    assert_eq!(
        issues::comment(
            &f.database,
            &member,
            &CommentCommand::parse(raw.clone()).unwrap()
        )
        .await
        .unwrap()["status"],
        "conflict"
    );
    raw["commandKey"] = json!(Uuid::new_v4());
    raw["action"] = json!("delete");
    raw["expectedVersion"] = json!(1);
    raw.as_object_mut().unwrap().remove("document");
    let deleted = issues::comment(
        &f.database,
        &member,
        &CommentCommand::parse(raw.clone()).unwrap(),
    )
    .await
    .unwrap();
    let issue = &deleted["records"][0]["issue"];
    assert_eq!(issue["comments"][0]["body"], "");
    assert!(issue["comments"][0].get("document").is_none());
    issues::edit(
        &f.database,
        &f.actor,
        &edit_input(team, issue, json!({"title":"Unrelated edit"})),
        IssueOptions::default(),
    )
    .await
    .unwrap();
    let raw_body: String =
        sqlx::query_scalar("SELECT properties->'comments'->0->>'body' FROM issues WHERE id=$1")
            .bind(issue_id(issue))
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(raw_body, "Edited by moderator");
    raw["commandKey"] = json!(Uuid::new_v4());
    raw["action"] = json!("restore");
    raw["expectedVersion"] = json!(2);
    let restored = issues::comment(&f.database, &member, &CommentCommand::parse(raw).unwrap())
        .await
        .unwrap();
    assert_eq!(
        restored["records"][0]["issue"]["comments"][0]["body"],
        "Edited by moderator"
    );
}

#[tokio::test]
async fn mentions_use_recipient_access_and_resolve_names_without_duplicate_events() {
    let f = Fixture::new().await;
    let other = Fixture::new().await;
    let member = enter_workspace(&f, &other).await;
    let team = team(&f, 1).await;
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
    let issue = create(&f, team, "Private mentions").await;
    let mut raw = comment_input(team, &issue);
    raw["document"] = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"mention","attrs":{"id":member.user_id,"label":"Spoofed administrator"}}]}]});
    let input = CommentCommand::parse(raw.clone()).unwrap();
    assert_eq!(
        issues::comment(&f.database, &f.actor, &input)
            .await
            .unwrap()["status"],
        "rejected"
    );
    sqlx::query(
        "INSERT INTO team_members(workspace_id,team_id,user_id,role) VALUES($1,$2,$3,'member')",
    )
    .bind(&f.actor.workspace_id)
    .bind(team)
    .bind(&member.user_id)
    .execute(&f.pool)
    .await
    .unwrap();
    let saved = issues::comment(&f.database, &f.actor, &input)
        .await
        .unwrap();
    assert_eq!(
        saved["records"][0]["issue"]["comments"][0]["body"],
        "@Original Actor"
    );
    issues::comment(&f.database, &f.actor, &input)
        .await
        .unwrap();
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM command_outbox_events WHERE workspace_id=$1 AND topic='issue.comment.mentioned'").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(count, 1);
    let targets = issues::mentions(&f.database, &f.actor, issue_id(&issue), "Original")
        .await
        .unwrap();
    assert_eq!(targets["targets"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn desired_reactions_and_subscriptions_do_not_duplicate_revisions_or_activity() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let issue = create(&f, team, "Engagement").await;
    let mut raw = json!({"commandKey":Uuid::new_v4(),"teamId":team,"issueId":issue["id"],"action":"subscription","subscribed":true});
    let no_op = issues::engagement(&f.database, &f.actor, raw.clone())
        .await
        .unwrap();
    assert_eq!(no_op["records"][0]["issue"]["revision"], issue["revision"]);
    raw["commandKey"] = json!(Uuid::new_v4());
    raw["subscribed"] = json!(false);
    let changed = issues::engagement(&f.database, &f.actor, raw)
        .await
        .unwrap();
    assert_eq!(changed["records"][0]["issue"]["subscribers"], "");
    let mut reaction = json!({"commandKey":Uuid::new_v4(),"teamId":team,"issueId":issue["id"],"action":"reaction","emoji":"❤️","present":true});
    let added = issues::engagement(&f.database, &f.actor, reaction.clone())
        .await
        .unwrap();
    assert_eq!(added["records"][0]["issue"]["reactions"][0]["emoji"], "❤");
    reaction["commandKey"] = json!(Uuid::new_v4());
    let repeat = issues::engagement(&f.database, &f.actor, reaction.clone())
        .await
        .unwrap();
    assert_eq!(
        repeat["records"][0]["issue"]["revision"],
        added["records"][0]["issue"]["revision"]
    );
    reaction["commandKey"] = json!(Uuid::new_v4());
    reaction["emoji"] = json!("invented");
    assert_eq!(
        issues::engagement(&f.database, &f.actor, reaction)
            .await
            .unwrap()["status"],
        "rejected"
    );
}

fn relation(a: &Value, b: &Value, kind: &str) -> Value {
    json!({"commandKey":Uuid::new_v4(),"issueId":a["id"],"targetId":b["id"],"expectedRevision":a["revision"],"expectedTargetRevision":b["revision"],"kind":kind,"action":"add"})
}
#[tokio::test]
async fn relationships_are_reciprocal_and_cycle_failures_leave_no_partial_updates() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let a = create(&f, team, "Parent").await;
    let b = create(&f, team, "Child").await;
    let input = relation(&a, &b, "child");
    let saved = issues::relationship(&f.database, &f.actor, input.clone())
        .await
        .unwrap();
    assert_eq!(saved["status"], "saved");
    assert_eq!(
        issues::relationship(&f.database, &f.actor, input)
            .await
            .unwrap()["replayed"],
        true
    );
    let parent = issues::relationships(&f.database, &f.actor, json!({"issueId":a["id"]}))
        .await
        .unwrap();
    assert_eq!(parent["relationships"][0]["kind"], "child");
    let child = issues::relationships(&f.database, &f.actor, json!({"issueId":b["id"]}))
        .await
        .unwrap();
    assert_eq!(child["relationships"][0]["kind"], "parent");
    let a = current(&f, issue_id(&a)).await;
    let b = current(&f, issue_id(&b)).await;
    let cycle = issues::relationship(&f.database, &f.actor, relation(&b, &a, "child"))
        .await
        .unwrap();
    assert_eq!(cycle["status"], "invalid");
    assert_eq!(current(&f, issue_id(&a)).await["revision"], a["revision"]);
    let search = issues::search_relationships(
        &f.database,
        &f.actor,
        json!({"issueId":a["id"],"search":"Child"}),
    )
    .await
    .unwrap();
    assert_eq!(search["issues"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn history_pagination_binds_identity_and_keeps_comment_bodies_out_of_events() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let issue = create(&f, team, "History").await;
    let input = CommentCommand::parse(comment_input(team, &issue)).unwrap();
    issues::comment(&f.database, &f.actor, &input)
        .await
        .unwrap();
    let page = issues::history(
        &f.database,
        &f.actor,
        json!({"issueId":issue["id"],"limit":1}),
    )
    .await
    .unwrap();
    assert_eq!(page["entries"].as_array().unwrap().len(), 1);
    assert!(page["nextCursor"].is_string());
    let older = issues::history(
        &f.database,
        &f.actor,
        json!({"issueId":issue["id"],"limit":1,"cursor":page["nextCursor"]}),
    )
    .await
    .unwrap();
    assert_eq!(older["entries"][0]["topic"], "issue.created");
    assert_ne!(older["entries"][0]["id"], page["entries"][0]["id"]);
    let other = create(&f, team, "Other").await;
    assert!(
        issues::history(
            &f.database,
            &f.actor,
            json!({"issueId":other["id"],"cursor":page["nextCursor"]})
        )
        .await
        .is_err()
    );
    let payloads: Vec<Value> =
        sqlx::query_scalar("SELECT payload FROM command_outbox_events WHERE workspace_id=$1")
            .bind(&f.actor.workspace_id)
            .fetch_all(&f.pool)
            .await
            .unwrap();
    assert!(
        payloads
            .iter()
            .all(|v| !v.to_string().contains("A useful comment"))
    );
}

#[tokio::test]
async fn compose_attachments_are_owned_pending_jobs_and_never_accepted_from_api_keys() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let mut raw = create_input(team, "Files");
    raw["draft"]["attachments"] =
        json!([{"name":"hello.txt","data":"data:text/plain;base64,SGVsbG8="}]);
    let input = CreateIssue::parse(raw).unwrap();
    let saved = issues::create(&f.database, &f.actor, &input, IssueOptions::default())
        .await
        .unwrap();
    assert_eq!(saved["issue"]["attachments"], json!([]));
    let encoded: String =
        sqlx::query_scalar("SELECT encoded_value FROM product_state WHERE workspace_id=$1")
            .bind(&f.actor.workspace_id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    let inner: String = serde_json::from_str(&encoded).unwrap();
    let job: Value = serde_json::from_str(&inner).unwrap();
    assert_eq!(job["issueId"], saved["issue"]["id"]);
    assert_eq!(job["completed"], false);
    let key = forge_store::api_keys::create(
        &f.database,
        &f.actor,
        &forge_store::api_keys::CreateKey {
            name: "Files API".into(),
            expires_in_days: 90,
            scopes: vec![ApiScope::IssuesRead, ApiScope::IssuesWrite],
        },
    )
    .await
    .unwrap();
    let actor = forge_store::authority::api_key_actor(&f.database, key["key"].as_str().unwrap())
        .await
        .unwrap();
    assert!(matches!(
        issues::create(&f.database, &actor, &input, IssueOptions::default()).await,
        Err(StoreError::Forbidden)
    ));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM issues WHERE team_id=$1")
        .bind(team)
        .fetch_one(&f.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn comment_upload_binding_rechecks_verified_metadata_and_rolls_back_rejected_content() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let issue = create(&f, team, "Attachment binding").await;
    let file = Uuid::new_v4();
    let checksum = "a".repeat(64);
    let storage = format!("files/{file}");
    sqlx::query("INSERT INTO file_upload_intents(id,workspace_id,user_id,command_key,input_hash,target,name,content_type,size_bytes,checksum,storage_reference,state,expires_at,result) VALUES($1,$2,$3,$4,$5,$6,'hello.txt','text/plain',5,$7,$8,'ready',now()+interval '1 day',$9)")
        .bind(file).bind(&f.actor.workspace_id).bind(&f.actor.user_id).bind(Uuid::new_v4()).bind("b".repeat(64)).bind(json!({"kind":"issue","id":issue["id"]})).bind(&checksum).bind(&storage).bind(json!({"checksum":"wrong","sizeBytes":5,"contentType":"text/plain"})).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO resource_files(id,workspace_id,created_by_user_id,issue_id,attachment_state,name,content_type,size_bytes,checksum,storage_reference) VALUES($1,$2,$3,$4,'unbound','hello.txt','text/plain',5,$5,$6)").bind(file).bind(&f.actor.workspace_id).bind(&f.actor.user_id).bind(issue_id(&issue)).bind(&checksum).bind(&storage).execute(&f.pool).await.unwrap();
    let mut raw = comment_input(team, &issue);
    raw["uploadIds"] = json!([file]);
    let input = CommentCommand::parse(raw.clone()).unwrap();
    assert_eq!(
        issues::comment(&f.database, &f.actor, &input)
            .await
            .unwrap()["status"],
        "rejected"
    );
    assert_eq!(current(&f, issue_id(&issue)).await["comments"], json!([]));
    sqlx::query("UPDATE file_upload_intents SET result=$1 WHERE id=$2")
        .bind(json!({"checksum":checksum,"sizeBytes":5,"contentType":"text/plain"}))
        .bind(file)
        .execute(&f.pool)
        .await
        .unwrap();
    let saved = issues::comment(&f.database, &f.actor, &input)
        .await
        .unwrap();
    assert_eq!(
        saved["records"][0]["issue"]["comments"][0]["attachments"][0]["fileId"],
        file.to_string()
    );
    raw["commandKey"] = json!(Uuid::new_v4());
    raw["commentId"] = json!(Uuid::new_v4());
    assert_eq!(
        issues::comment(&f.database, &f.actor, &CommentCommand::parse(raw).unwrap())
            .await
            .unwrap()["status"],
        "rejected"
    );
}

#[tokio::test]
async fn issue_field_validation_rejects_ambiguous_labels_and_redacts_private_project_links() {
    let f = Fixture::new().await;
    let visitor = Fixture::new().await;
    let member = enter_workspace(&f, &visitor).await;
    let public = team(&f, 1).await;
    let private = team(&f, 2).await;
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(private)
        .execute(&f.pool)
        .await
        .unwrap();
    for scope in [None, Some(public)] {
        sqlx::query(
            "INSERT INTO resource_labels(workspace_id,team_id,name) VALUES($1,$2,'Ambiguous')",
        )
        .bind(&f.actor.workspace_id)
        .bind(scope)
        .execute(&f.pool)
        .await
        .unwrap();
    }
    let mut raw = create_input(public, "Ambiguous");
    raw["draft"]["labels"] = json!("Ambiguous");
    assert!(
        issues::create(
            &f.database,
            &f.actor,
            &CreateIssue::parse(raw).unwrap(),
            IssueOptions::default()
        )
        .await
        .is_err()
    );
    let project = Uuid::new_v4();
    sqlx::query("INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'Private project')")
        .bind(project)
        .bind(&f.actor.workspace_id)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO project_teams(workspace_id,team_id,project_id) VALUES($1,$2,$3)")
        .bind(&f.actor.workspace_id)
        .bind(private)
        .bind(project)
        .execute(&f.pool)
        .await
        .unwrap();
    let issue = create(&f, public, "Visible issue").await;
    sqlx::query("UPDATE issues SET project_id=$1 WHERE id=$2")
        .bind(project)
        .bind(issue_id(&issue))
        .execute(&f.pool)
        .await
        .unwrap();
    let snapshot = issues::read(&f.database, &member, false).await.unwrap();
    assert_eq!(snapshot["records"][0]["issue"]["project"], "");
    assert_eq!(snapshot["projects"], json!([]));
}
