use super::{
    Fixture, enter_workspace,
    issue_acceptance::{create, create_input, team},
};
use forge_core::{
    comments::CommentCommand,
    cycles,
    issue_query::IssueQuery,
    issues::{CreateIssue, EditIssues},
};
use forge_store::{
    StoreError,
    issues::{self, IssueOptions},
};
use serde_json::{Value, json};
use uuid::Uuid;
fn id(issue: &Value) -> Uuid {
    issue["id"].as_str().unwrap().parse().unwrap()
}
fn command(team: Uuid, issue: &Value, action: &str) -> Value {
    json!({"teamId":team,"issueId":issue["id"],"commandKey":Uuid::new_v4(),"expectedRevision":issue["revision"],"action":action})
}
async fn current(f: &Fixture, issue: Uuid) -> Value {
    issues::read(&f.database, &f.actor, false).await.unwrap()["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["issue"]["id"] == issue.to_string())
        .unwrap()["issue"]
        .clone()
}
fn settings(team: Uuid, revision: i32, value: Value) -> Value {
    json!({"teamId":team,"kind":"cycles","commandKey":Uuid::new_v4(),"expectedRevision":revision,"value":value.to_string()})
}

#[tokio::test]
async fn issue_lifecycle_preserves_discussion_and_returns_live_availability_on_replay() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let issue = create(&f, team, "Recover me").await;
    let comment=CommentCommand::parse(json!({"teamId":team,"issueId":issue["id"],"commandKey":Uuid::new_v4(),"commentId":Uuid::new_v4(),"action":"create","document":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Keep this discussion"}]}]}})).unwrap();
    issues::comment(&f.database, &f.actor, &comment)
        .await
        .unwrap();
    let issue = current(&f, id(&issue)).await;
    let delete = command(team, &issue, "delete");
    let deleted = issues::lifecycle(&f.database, &f.actor, delete.clone())
        .await
        .unwrap();
    assert_eq!(deleted["value"]["active"], false);
    assert_eq!(
        issues::query(
            &f.database,
            &f.actor,
            &IssueQuery::parse(json!({})).unwrap()
        )
        .await
        .unwrap()["total"],
        0
    );
    assert!(
        issues::comment(&f.database, &f.actor, &comment)
            .await
            .is_err()
    );
    let inactive = issues::inactive(
        &f.database,
        &f.actor,
        json!({"teamId":team,"kind":"deleted"}),
    )
    .await
    .unwrap();
    assert_eq!(inactive["items"][0]["id"], issue["id"]);
    assert!(!inactive.to_string().contains("Keep this discussion"));
    let until = chrono::DateTime::parse_from_rfc3339(
        inactive["items"][0]["recoverUntil"].as_str().unwrap(),
    )
    .unwrap();
    let at =
        chrono::DateTime::parse_from_rfc3339(inactive["items"][0]["deletedAt"].as_str().unwrap())
            .unwrap();
    assert_eq!((until - at).num_hours(), 720);
    let mut restore = command(team, &issue, "restore");
    restore["expectedRevision"] = deleted["value"]["revision"].clone();
    let restored = issues::lifecycle(&f.database, &f.actor, restore.clone())
        .await
        .unwrap();
    assert_eq!(restored["value"]["active"], true);
    let issue = current(&f, id(&issue)).await;
    assert_eq!(issue["comments"][0]["body"], "Keep this discussion");
    assert_eq!(issue["subscribers"], f.actor.user_id);
    let replay = issues::lifecycle(&f.database, &f.actor, delete)
        .await
        .unwrap();
    assert_eq!(replay["replayed"], true);
    assert_eq!(replay["value"], restored["value"]);
    let archived = issues::lifecycle(&f.database, &f.actor, command(team, &issue, "archive"))
        .await
        .unwrap();
    assert_eq!(
        issues::inactive(
            &f.database,
            &f.actor,
            json!({"teamId":team,"kind":"archived"})
        )
        .await
        .unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let replay = issues::lifecycle(&f.database, &f.actor, restore)
        .await
        .unwrap();
    assert_eq!(replay["value"], archived["value"]);
    let mut unarchive = command(team, &issue, "unarchive");
    unarchive["expectedRevision"] = archived["value"]["revision"].clone();
    assert_eq!(
        issues::lifecycle(&f.database, &f.actor, unarchive)
            .await
            .unwrap()["value"]["active"],
        true
    );
}

#[tokio::test]
async fn issue_lifecycle_competing_revisions_and_expired_recovery_never_overwrite() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let issue = create(&f, team, "Competing").await;
    let (a, b) = tokio::join!(
        issues::lifecycle(&f.database, &f.actor, command(team, &issue, "archive")),
        issues::lifecycle(&f.database, &f.actor, command(team, &issue, "delete"))
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_ne!(a["status"], b["status"]);
    assert!([a["status"].as_str().unwrap(), b["status"].as_str().unwrap()].contains(&"conflict"));
    let expired = create(&f, team, "Expired").await;
    let revision:i32=sqlx::query_scalar("UPDATE issues SET deleted_at=clock_timestamp()-interval '720 hours' WHERE id=$1 RETURNING revision").bind(id(&expired)).fetch_one(&f.pool).await.unwrap();
    let mut restore = command(team, &expired, "restore");
    restore["expectedRevision"] = json!(revision);
    assert!(matches!(
        issues::lifecycle(&f.database, &f.actor, restore).await,
        Err(StoreError::IssueValidation(
            "The issue recovery period has ended."
        ))
    ));
    let rows = issues::inactive(
        &f.database,
        &f.actor,
        json!({"teamId":team,"kind":"deleted"}),
    )
    .await
    .unwrap();
    assert!(
        !rows["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == expired["id"])
    );
    let error = sqlx::query("UPDATE issues SET deleted_at=NULL WHERE id=$1")
        .bind(id(&expired))
        .execute(&f.pool)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().constraint(),
        Some("issue_recovery_expired")
    );
}

#[tokio::test]
async fn issue_restore_and_creation_compete_for_the_same_capacity_slot() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let issue = create(&f, team, "Restore capacity").await;
    let deleted = issues::lifecycle(&f.database, &f.actor, command(team, &issue, "delete"))
        .await
        .unwrap();
    sqlx::query("INSERT INTO issues(workspace_id,team_id,number,title,status_id) SELECT $1,$2,n,'Capacity '||n,'todo' FROM generate_series(2,251) n").bind(&f.actor.workspace_id).bind(team).execute(&f.pool).await.unwrap();
    let mut restore = command(team, &issue, "restore");
    restore["expectedRevision"] = deleted["value"]["revision"].clone();
    assert!(
        issues::lifecycle(&f.database, &f.actor, restore.clone())
            .await
            .is_err()
    );
    let remaining: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT deleted_at FROM issues WHERE id=$1")
            .bind(id(&issue))
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(remaining.is_some());
    sqlx::query("UPDATE issues SET archived_at=clock_timestamp() WHERE team_id=$1 AND number=251")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
    let new = CreateIssue::parse(create_input(team, "Last slot")).unwrap();
    let (a, b) = tokio::join!(
        issues::lifecycle(&f.database, &f.actor, restore),
        issues::create(&f.database, &f.actor, &new, IssueOptions::default())
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM issues WHERE workspace_id=$1 AND deleted_at IS NULL AND archived_at IS NULL").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(count, 250);
}

#[tokio::test]
async fn inactive_issue_pages_are_bounded_and_recheck_private_membership() {
    let f = Fixture::new().await;
    let v = Fixture::new().await;
    let member = enter_workspace(&f, &v).await;
    let team = team(&f, 1).await;
    sqlx::query("INSERT INTO issues(workspace_id,team_id,number,title,status_id,deleted_at) SELECT $1,$2,n,'Deleted '||n,'todo',now()-interval '1 day' FROM generate_series(1,55) n").bind(&f.actor.workspace_id).bind(team).execute(&f.pool).await.unwrap();
    let first = issues::inactive(
        &f.database,
        &member,
        json!({"teamId":team,"kind":"deleted"}),
    )
    .await
    .unwrap();
    assert_eq!(first["items"].as_array().unwrap().len(), 50);
    let last = issues::inactive(
        &f.database,
        &member,
        json!({"teamId":team,"kind":"deleted","after":first["nextCursor"]}),
    )
    .await
    .unwrap();
    assert_eq!(last["items"].as_array().unwrap().len(), 5);
    assert_eq!(last["nextCursor"], Value::Null);
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        issues::inactive(
            &f.database,
            &member,
            json!({"teamId":team,"kind":"deleted","after":first["nextCursor"]})
        )
        .await,
        Err(StoreError::Forbidden)
    ));
    let row = &first["items"][0];
    assert!(matches!(
        issues::lifecycle(&f.database, &member, command(team, row, "restore")).await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn shared_cycles_keep_windows_numbers_memberships_and_timezones_when_settings_change() {
    let f = Fixture::new().await;
    let v = Fixture::new().await;
    let member = enter_workspace(&f, &v).await;
    let team = team(&f, 1).await;
    let mut config = cycles::initial();
    config["enabled"] = json!(true);
    config["timezone"] = json!("europe/paris");
    config["futureCycles"] = json!(4);
    let input = settings(team, 0, config.clone());
    let saved = issues::save_team_settings(&f.database, &f.actor, input.clone())
        .await
        .unwrap();
    assert_eq!(saved["value"]["revision"], 1);
    let (a, b) = tokio::join!(
        issues::read_cycles(&f.database, &f.actor, team, None),
        issues::read_cycles(&f.database, &member, team, None)
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a["cycles"], b["cycles"]);
    assert_eq!(b["canManage"], false);
    assert_eq!(b["settings"]["timezone"], "Europe/Paris");
    assert_eq!(a["cycles"].as_array().unwrap().len(), 4);
    let cycle = &a["cycles"][0];
    let mut raw = create_input(team, "Scheduled issue");
    raw["draft"]["cycle"] = cycle["id"].clone();
    raw["draft"]["status"] = json!("done");
    issues::create(
        &f.database,
        &f.actor,
        &CreateIssue::parse(raw).unwrap(),
        IssueOptions::default(),
    )
    .await
    .unwrap();
    config["duration"] = json!(1);
    config["cooldown"] = json!(0);
    config["timezone"] = json!("America/Los_Angeles");
    config["futureCycles"] = json!(6);
    issues::save_team_settings(&f.database, &f.actor, settings(team, 1, config.clone()))
        .await
        .unwrap();
    let changed = issues::read_cycles(&f.database, &member, team, None)
        .await
        .unwrap();
    assert_eq!(changed["cycles"].as_array().unwrap().len(), 6);
    for old in a["cycles"].as_array().unwrap() {
        let new = changed["cycles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == old["id"])
            .unwrap();
        for key in ["number", "startDate", "endDate", "timezone"] {
            assert_eq!(new[key], old[key]);
        }
    }
    assert_eq!(changed["cycles"][0]["issueCount"], 1);
    assert_eq!(changed["cycles"][0]["completedCount"], 1);
    assert_eq!(
        issues::save_team_settings(&f.database, &f.actor, input)
            .await
            .unwrap()["replayed"],
        true
    );
    assert_eq!(
        issues::read_cycles(&f.database, &f.actor, team, None)
            .await
            .unwrap()["revision"],
        2
    );
    assert!(matches!(
        issues::save_team_settings(&f.database, &member, settings(team, 2, config)).await,
        Err(StoreError::Forbidden)
    ));
    assert!(
        sqlx::query("UPDATE issue_cycles SET end_date='2099-01-01' WHERE id=$1")
            .bind(cycle["id"].as_str().unwrap().parse::<Uuid>().unwrap())
            .execute(&f.pool)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn cycle_configuration_races_and_stale_equal_values_commit_once() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let mut a = cycles::initial();
    a["enabled"] = json!(true);
    a["futureCycles"] = json!(2);
    let mut b = a.clone();
    b["futureCycles"] = json!(3);
    let first = settings(team, 0, a);
    let second = settings(team, 0, b);
    let (a, b) = tokio::join!(
        issues::save_team_settings(&f.database, &f.actor, first.clone()),
        issues::save_team_settings(&f.database, &f.actor, second.clone())
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let mut winner = if a.is_ok() { first } else { second };
    winner["commandKey"] = json!(Uuid::new_v4());
    assert_eq!(
        issues::save_team_settings(&f.database, &f.actor, winner)
            .await
            .unwrap()["value"]["revision"],
        1
    );
    let snapshot = issues::read_cycles(&f.database, &f.actor, team, None)
        .await
        .unwrap();
    assert_eq!(snapshot["revision"], 1);
    assert_eq!(
        snapshot["cycles"].as_array().unwrap().len(),
        snapshot["settings"]["futureCycles"].as_u64().unwrap() as usize
    );
}

#[tokio::test]
async fn cycle_history_keeps_a_requested_number_beyond_the_recent_window() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    sqlx::query("INSERT INTO issue_cycles(workspace_id,team_id,start_date,end_date,timezone) SELECT $1,$2,to_char(date '2020-01-01'+(n*14),'YYYY-MM-DD'),to_char(date '2020-01-01'+(n*14)+13,'YYYY-MM-DD'),'Europe/Paris' FROM generate_series(0,104) n ORDER BY n").bind(&f.actor.workspace_id).bind(team).execute(&f.pool).await.unwrap();
    let recent = issues::read_cycles(&f.database, &f.actor, team, None)
        .await
        .unwrap();
    assert_eq!(recent["cycles"].as_array().unwrap().len(), 100);
    let page = issues::read_cycles(&f.database, &f.actor, team, Some(1))
        .await
        .unwrap();
    assert_eq!(page["cycles"].as_array().unwrap().len(), 101);
    assert_eq!(page["cycles"][0]["number"], 1);
    let now = chrono::DateTime::parse_from_rfc3339("2020-01-01T23:30:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let states = issues::read_cycles_at(&f.database, &f.actor, team, Some(1), now)
        .await
        .unwrap();
    assert_eq!(states["cycles"][0]["state"], "Current");
    assert_eq!(states["cycles"][1]["state"], "Upcoming");
    assert_eq!(states["cycles"][2]["state"], "Planned");
}

#[tokio::test]
async fn triage_settings_and_decisions_preserve_identity_and_conflict_atomically() {
    let f = Fixture::new().await;
    let v = Fixture::new().await;
    let member = enter_workspace(&f, &v).await;
    let team = team(&f, 1).await;
    let config = json!({"teamId":team,"kind":"triage","commandKey":Uuid::new_v4(),"expectedRevision":0,"value":json!({"enabled":true,"requirePriority":true,"action":"assign"}).to_string()});
    assert!(
        issues::save_team_settings(&f.database, &member, config.clone())
            .await
            .is_err()
    );
    issues::save_team_settings(&f.database, &f.actor, config)
        .await
        .unwrap();
    assert_eq!(
        issues::read_triage(&f.database, &member, team)
            .await
            .unwrap()["settings"]["enabled"],
        true
    );
    let mut raw = create_input(team, "Triage me");
    raw["draft"]["triage"] = json!(true);
    raw["draft"]["snoozed"] = json!(true);
    let issue = issues::create(
        &f.database,
        &f.actor,
        &CreateIssue::parse(raw).unwrap(),
        IssueOptions::default(),
    )
    .await
    .unwrap()["issue"]
        .clone();
    let base = json!({"teamId":team,"commandKey":Uuid::new_v4(),"edits":[{"issueId":issue["id"],"expectedRevision":0,"triageDecision":"accept","changes":{"status":"todo","assignee":member.user_id}}]});
    let mut bad = base.clone();
    bad["edits"][0]["changes"]["priority"] = json!("High");
    assert!(
        issues::edit(
            &f.database,
            &member,
            &EditIssues::parse(bad).unwrap(),
            IssueOptions::default()
        )
        .await
        .is_err()
    );
    let accepted = EditIssues::parse(base.clone()).unwrap();
    let mut decline = base;
    decline["commandKey"] = json!(Uuid::new_v4());
    decline["edits"][0]["triageDecision"] = json!("decline");
    decline["edits"][0]["changes"] = json!({"status":"canceled"});
    let declined = EditIssues::parse(decline).unwrap();
    let (a, b) = tokio::join!(
        issues::edit(&f.database, &member, &accepted, IssueOptions::default()),
        issues::edit(&f.database, &member, &declined, IssueOptions::default())
    );
    let a = a.unwrap();
    let b = b.unwrap();
    assert_ne!(a["status"], b["status"]);
    let updated = current(&f, id(&issue)).await;
    assert_eq!(updated["triage"], false);
    assert_eq!(updated["snoozed"], false);
    assert_eq!(updated["id"], issue["id"]);
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM command_outbox_events WHERE workspace_id=$1 AND topic IN ('issue.triage.accepted','issue.triage.declined')").bind(&f.actor.workspace_id).fetch_one(&f.pool).await.unwrap();
    assert_eq!(count, 1);
}
