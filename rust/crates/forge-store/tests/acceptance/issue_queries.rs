use super::{
    Fixture, enter_workspace,
    issue_acceptance::{create, create_input, team},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use forge_core::{
    actor::{Actor, ApiScope},
    issue_query::{IssueQuery, default_display},
    issues::CreateIssue,
};
use forge_store::{
    StoreError,
    issues::{self, IssueOptions},
};
use serde_json::{Value, json};
use uuid::Uuid;

async fn query(f: &Fixture, actor: &Actor, input: Value) -> Value {
    issues::query(&f.database, actor, &IssueQuery::parse(input).unwrap())
        .await
        .unwrap()
}
async fn seed(f: &Fixture, team: Uuid, n: i32) {
    sqlx::query("INSERT INTO issues(workspace_id,team_id,number,title,status_id,creator_id,properties) SELECT $1,$2,n,'Fixture '||n,'todo',$3,jsonb_build_object('description','Searchable description','priority',CASE WHEN n%2=0 THEN 'High' ELSE 'Low' END) FROM generate_series(1,$4) n").bind(&f.actor.workspace_id).bind(team).bind(&f.actor.user_id).bind(n).execute(&f.pool).await.unwrap();
}
fn ids(page: &Value) -> Vec<String> {
    page["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["issue"]["id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn issue_query_pages_share_snapshot_counts_and_never_repeat_ids() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    seed(&f, team, 121).await;
    let first = query(&f, &f.actor, json!({"teamIds":[team],"limit":25})).await;
    assert_eq!(first["total"], 121);
    assert_eq!(first["facets"]["team"], json!([{"value":team,"count":121}]));
    let created = create(&f, team, "Created after first page").await;
    let mut all = ids(&first);
    let mut cursor = first["nextCursor"].clone();
    while !cursor.is_null() {
        let next = query(
            &f,
            &f.actor,
            json!({"teamIds":[team],"limit":25,"cursor":cursor}),
        )
        .await;
        assert_eq!(next["total"], 121);
        assert_eq!(next["resultRevision"], first["resultRevision"]);
        all.extend(ids(&next));
        cursor = next["nextCursor"].clone();
    }
    assert_eq!(all.len(), 121);
    assert_eq!(
        all.iter().collect::<std::collections::HashSet<_>>().len(),
        121
    );
    assert!(!all.iter().any(|id| created["id"] == *id));
    assert_eq!(query(&f, &f.actor, json!({})).await["total"], 122);
    assert_eq!(query(&f, &f.actor, json!({"teamIds":[]})).await["total"], 0);
}

#[tokio::test]
async fn issue_query_private_rows_and_projects_are_excluded_before_aggregates() {
    let f = Fixture::new().await;
    let v = Fixture::new().await;
    let member = enter_workspace(&f, &v).await;
    let public = team(&f, 1).await;
    let private = team(&f, 2).await;
    seed(&f, private, 3).await;
    sqlx::query("UPDATE teams SET visibility='private' WHERE id=$1")
        .bind(private)
        .execute(&f.pool)
        .await
        .unwrap();
    let empty = query(&f, &member, json!({"search":"Fixture"})).await;
    assert_eq!(empty["total"], 0);
    assert!(ids(&empty).is_empty());
    assert_eq!(empty["groups"], json!([]));
    assert!(
        empty["facets"]
            .as_object()
            .unwrap()
            .values()
            .all(|v| v == &json!([]))
    );
    assert!(!empty.to_string().contains(&private.to_string()));
    let project = Uuid::new_v4();
    sqlx::query("INSERT INTO projects(id,workspace_id,name) VALUES($1,$2,'Hidden project')")
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
    let visible = create(&f, public, "Visible").await;
    sqlx::query("UPDATE issues SET project_id=$1,parent_id=(SELECT id FROM issues WHERE team_id=$2 ORDER BY number LIMIT 1) WHERE id=$3").bind(project).bind(private).bind(visible["id"].as_str().unwrap().parse::<Uuid>().unwrap()).execute(&f.pool).await.unwrap();
    let page = query(&f, &member, json!({"project":""})).await;
    assert_eq!(page["total"], 1);
    assert_eq!(page["records"][0]["issue"]["parentId"], "");
    assert_eq!(page["facets"]["project"], json!([{"value":"","count":1}]));
    assert!(!page.to_string().contains(&project.to_string()));
    assert_eq!(
        query(&f, &member, json!({"project":project})).await["total"],
        0
    );
    sqlx::query("INSERT INTO team_members(workspace_id,team_id,user_id) VALUES($1,$2,$3)")
        .bind(&f.actor.workspace_id)
        .bind(private)
        .bind(&member.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let first = query(&f, &member, json!({"teamIds":[private],"limit":1})).await;
    assert_eq!(first["total"], 3);
    sqlx::query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2")
        .bind(private)
        .bind(&member.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    let next = query(
        &f,
        &member,
        json!({"teamIds":[private],"limit":1,"cursor":first["nextCursor"]}),
    )
    .await;
    assert_eq!(next["total"], 0);
    assert_eq!(next["records"], json!([]));
    assert_eq!(next["rollups"], json!([]));
}

#[tokio::test]
async fn issue_query_filters_literal_search_nested_expansion_and_all_sort_orders() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let mut raw = create_input(team, "Literal 100%_needle");
    raw["draft"]["priority"] = json!("High");
    raw["draft"]["description"] = json!("Search bounded description");
    raw["draft"]["dueDate"] = json!("2026-12-10");
    raw["draft"]["subIssues"] = json!(["Nonmatching child"]);
    let parent = issues::create(
        &f.database,
        &f.actor,
        &CreateIssue::parse(raw).unwrap(),
        IssueOptions::default(),
    )
    .await
    .unwrap()["issue"]
        .clone();
    assert_eq!(
        query(&f, &f.actor, json!({"search":"100%_needle"})).await["total"],
        1
    );
    assert_eq!(
        query(&f, &f.actor, json!({"search":"' OR 1=1 --"})).await["total"],
        0
    );
    assert_eq!(
        query(&f, &f.actor, json!({"search":"BOUNDED DESCRIPTION"})).await["total"],
        1
    );
    let mut display = default_display();
    display["nested"] = json!("Show all");
    assert_eq!(
        query(
            &f,
            &f.actor,
            json!({"search":"100%_needle","display":display})
        )
        .await["total"],
        2
    );
    display["showSubIssues"] = json!(false);
    assert_eq!(
        query(&f, &f.actor, json!({"display":display})).await["total"],
        1
    );
    for (field, op, value, total) in [
        ("priority", "is", " HIGH ", 1),
        ("priority", "isNot", "High", 1),
        ("description", "contains", "bounded", 1),
        ("description", "notContains", "bounded", 1),
        ("dueDate", "set", "", 1),
        ("dueDate", "notSet", "", 1),
        ("dueDate", "before", "2026-12-11", 1),
        ("dueDate", "after", "2026-12-09", 1),
    ] {
        let page=query(&f,&f.actor,json!({"filters":{"match":"all","rules":[{"id":"rule","field":field,"operator":op,"value":value}]}})).await;
        assert_eq!(page["total"], total, "{field} {op}");
    }
    let rules = json!([{"id":"a","field":"priority","operator":"is","value":"High"},{"id":"b","field":"description","operator":"notContains","value":"bounded"}]);
    assert_eq!(
        query(
            &f,
            &f.actor,
            json!({"filters":{"match":"any","rules":rules}})
        )
        .await["total"],
        2
    );
    assert_eq!(
        query(
            &f,
            &f.actor,
            json!({"filters":{"match":"all","rules":rules}})
        )
        .await["total"],
        0
    );
    for order in [
        "Priority", "Created", "Updated", "Due date", "Title", "Status",
    ] {
        for descending in [false, true] {
            let mut display = default_display();
            display["order"] = json!(order);
            display["descending"] = json!(descending);
            let a = query(&f, &f.actor, json!({"limit":1,"display":display})).await;
            let b = query(
                &f,
                &f.actor,
                json!({"limit":1,"display":display,"cursor":a["nextCursor"]}),
            )
            .await;
            assert_ne!(ids(&a), ids(&b), "{order} {descending}");
            assert_eq!(b["nextCursor"], Value::Null);
            assert_eq!(a["total"], 2);
            assert_eq!(b["total"], 2);
        }
    }
    assert_eq!(
        query(&f, &f.actor, json!({"search":"T1-1"})).await["records"][0]["issue"]["id"],
        parent["id"]
    );
}

#[tokio::test]
async fn issue_query_board_groups_labels_rollups_and_revision_reflect_canonical_state() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    sqlx::query("UPDATE issue_statuses SET name='Ready' WHERE team_id=$1 AND id='todo'")
        .bind(team)
        .execute(&f.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO resource_labels(workspace_id,team_id,name) VALUES($1,$2,'Zebra'),($1,$2,'Alpha')").bind(&f.actor.workspace_id).bind(team).execute(&f.pool).await.unwrap();
    let mut raw = create_input(team, "Labelled");
    raw["draft"]["labels"] = json!("Zebra,Alpha");
    let issue = issues::create(
        &f.database,
        &f.actor,
        &CreateIssue::parse(raw).unwrap(),
        IssueOptions::default(),
    )
    .await
    .unwrap()["issue"]
        .clone();
    let page = query(&f, &f.actor, json!({})).await;
    assert_eq!(page["records"][0]["issue"]["labels"], "Alpha,Zebra");
    assert_eq!(
        page["groups"],
        json!([{"group":"Ready","subgroup":"All issues","count":1}])
    );
    assert_eq!(
        page["projectTotals"],
        json!([{"project":"","count":1,"completed":0}])
    );
    let mut display = default_display();
    display["group"] = json!("Labels");
    assert_eq!(
        query(&f, &f.actor, json!({"display":display})).await["groups"],
        json!([{"group":"Alpha","subgroup":"All issues","count":1}])
    );
    let filter = json!({"match":"all","rules":[{"id":"label","field":"labels","operator":"is","value":"Zebra"}]});
    assert_eq!(
        query(&f, &f.actor, json!({"filters":filter})).await["total"],
        1
    );
    sqlx::query("UPDATE issues SET status_id='done',properties=properties||jsonb_build_object('milestone','m1') WHERE id=$1").bind(issue["id"].as_str().unwrap().parse::<Uuid>().unwrap()).execute(&f.pool).await.unwrap();
    let updated = query(&f, &f.actor, json!({"milestone":["m1"]})).await;
    assert_ne!(updated["resultRevision"], page["resultRevision"]);
    assert_eq!(
        updated["rollups"],
        json!([{"project":"","milestone":"m1","count":1,"completed":1}])
    );
    assert_eq!(
        query(&f, &f.actor, json!({"scope":"active"})).await["total"],
        0
    );
    assert_eq!(
        query(&f, &f.actor, json!({"milestone":[]})).await["total"],
        0
    );
    assert_eq!(
        query(&f, &f.actor, json!({"cycle":"missing"})).await["total"],
        0
    );
}

#[tokio::test]
async fn issue_query_cursor_is_bound_to_actor_parameters_and_expiration() {
    let f = Fixture::new().await;
    let v = Fixture::new().await;
    let member = enter_workspace(&f, &v).await;
    let team = team(&f, 1).await;
    seed(&f, team, 3).await;
    let first = query(&f, &f.actor, json!({"limit":1})).await;
    for (actor, input) in [
        (&member, json!({"limit":1,"cursor":first["nextCursor"]})),
        (
            &f.actor,
            json!({"limit":1,"search":"changed","cursor":first["nextCursor"]}),
        ),
        (&f.actor, json!({"cursor":"not-a-cursor"})),
    ] {
        assert!(
            issues::query(&f.database, actor, &IssueQuery::parse(input).unwrap())
                .await
                .is_err()
        );
    }
    let mut decoded: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(first["nextCursor"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    for (field, value) in [
        ("expires", json!(0)),
        ("snapshot", json!("9999-01-01T00:00:00Z")),
        ("version", json!(2)),
        ("values", json!(["1", "", "4", "000000000001", "malformed"])),
    ] {
        let old = decoded[field].clone();
        decoded[field] = value;
        let cursor = URL_SAFE_NO_PAD.encode(decoded.to_string().as_bytes());
        assert!(
            issues::query(
                &f.database,
                &f.actor,
                &IssueQuery::parse(json!({"limit":1,"cursor":cursor})).unwrap()
            )
            .await
            .is_err(),
            "{field}"
        );
        decoded[field] = old;
    }
    sqlx::query("DELETE FROM session WHERE token=$1")
        .bind(&f.token)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(matches!(
        issues::query(
            &f.database,
            &f.actor,
            &IssueQuery::parse(json!({})).unwrap()
        )
        .await,
        Err(StoreError::Forbidden)
    ));
}

#[tokio::test]
async fn issue_query_personal_and_triage_scopes_use_live_identity_and_flags() {
    let f = Fixture::new().await;
    let v = Fixture::new().await;
    let member = enter_workspace(&f, &v).await;
    let team = team(&f, 1).await;
    let mut raw = create_input(team, "Assigned triage");
    raw["assigneeId"] = json!(member.user_id);
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
    create(&f, team, "Other issue").await;
    for personal in ["created", "subscribed", "activity"] {
        assert_eq!(
            query(&f, &f.actor, json!({"personal":personal})).await["total"],
            2
        );
    }
    assert_eq!(
        query(&f, &member, json!({"personal":"assigned"})).await["total"],
        1
    );
    for personal in ["created", "subscribed", "activity"] {
        assert_eq!(
            query(&f, &member, json!({"personal":personal})).await["total"],
            0
        );
    }
    assert_eq!(
        query(&f, &f.actor, json!({"triage":true})).await["total"],
        0
    );
    assert_eq!(
        query(&f, &f.actor, json!({"triage":true,"showSnoozed":true})).await["total"],
        1
    );
    assert_eq!(
        query(&f, &f.actor, json!({"triage":false})).await["total"],
        1
    );
    issues::engagement(&f.database,&member,json!({"commandKey":Uuid::new_v4(),"issueId":issue["id"],"teamId":team,"action":"subscription","subscribed":true})).await.unwrap();
    assert_eq!(
        query(&f, &member, json!({"personal":"subscribed"})).await["total"],
        1
    );
    let command=forge_core::comments::CommentCommand::parse(json!({"commandKey":Uuid::new_v4(),"teamId":team,"issueId":issue["id"],"commentId":Uuid::new_v4(),"action":"create","document":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Comment"}]}]}})).unwrap();
    issues::comment(&f.database, &member, &command)
        .await
        .unwrap();
    assert_eq!(
        query(&f, &member, json!({"personal":"activity"})).await["total"],
        1
    );
}

#[tokio::test]
async fn issue_query_facets_are_bounded_and_issue_credentials_need_no_team_scope() {
    let f = Fixture::new().await;
    let team = team(&f, 1).await;
    let issue = create(&f, team, "Many labels").await;
    sqlx::query("INSERT INTO resource_labels(workspace_id,team_id,name) SELECT $1,$2,'L'||lpad(n::text,3,'0') FROM generate_series(1,101) n").bind(&f.actor.workspace_id).bind(team).execute(&f.pool).await.unwrap();
    sqlx::query("INSERT INTO issue_labels(workspace_id,issue_id,label_id) SELECT $1,$2,id FROM resource_labels WHERE team_id=$3").bind(&f.actor.workspace_id).bind(issue["id"].as_str().unwrap().parse::<Uuid>().unwrap()).bind(team).execute(&f.pool).await.unwrap();
    let page = query(&f, &f.actor, json!({})).await;
    assert_eq!(page["facets"]["labels"].as_array().unwrap().len(), 100);
    assert_eq!(page["facetsTruncated"], true);
    assert_eq!(page["total"], 1);
    let key = forge_store::api_keys::create(
        &f.database,
        &f.actor,
        &forge_store::api_keys::CreateKey {
            name: "Queries".into(),
            expires_in_days: 90,
            scopes: vec![ApiScope::IssuesRead],
        },
    )
    .await
    .unwrap();
    let actor = forge_store::authority::api_key_actor(&f.database, key["key"].as_str().unwrap())
        .await
        .unwrap();
    let page = query(&f, &actor, json!({})).await;
    assert_eq!(page["total"], 1);
    assert_eq!(page["sessionId"], "");
    sqlx::query("UPDATE apikey SET enabled=false WHERE reference_id=$1")
        .bind(&f.actor.user_id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert!(
        issues::query(&f.database, &actor, &IssueQuery::parse(json!({})).unwrap())
            .await
            .is_err()
    );
}
