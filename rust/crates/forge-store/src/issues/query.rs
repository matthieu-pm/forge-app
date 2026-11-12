use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use forge_core::issue_query::{self, IssueQuery};
use sqlx::types::Json;
#[derive(Deserialize)]
struct PageRow {
    id: Uuid,
    completion_key: String,
    completion_time: String,
    sort_key: String,
    number_key: String,
}
#[derive(Deserialize)]
struct Count {
    facet: String,
    value: String,
    count: i32,
}
#[derive(FromRow)]
struct Aggregated {
    total: i32,
    result_revision: String,
    page: Json<Vec<PageRow>>,
    counts: Json<Vec<Count>>,
    groups: Json<Vec<Value>>,
    project_totals: Json<Vec<Value>>,
    rollups: Json<Vec<Value>>,
}

pub async fn query(
    database: &Database,
    actor: &Actor,
    input: &IssueQuery,
) -> Result<Value, StoreError> {
    let mut tx = database.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout = '5000ms'")
        .execute(&mut *tx)
        .await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let actor = current_actor(&mut tx, actor).await?;
    policy::scope(&actor, ApiScope::IssuesRead)?;
    let binding = input.binding(&actor);
    let input = input.as_value();
    let cursor = input
        .get("cursor")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(|s| {
            let bytes = URL_SAFE_NO_PAD
                .decode(s)
                .map_err(|_| StoreError::InvalidInput)?;
            let value: Value =
                serde_json::from_slice(&bytes).map_err(|_| StoreError::InvalidInput)?;
            issue_query::cursor(value).map_err(|_| StoreError::InvalidInput)
        })
        .transpose()?;
    let now = Utc::now().timestamp_millis();
    if let Some(c) = &cursor {
        let timestamp = DateTime::parse_from_rfc3339(text(c, "snapshot"))
            .map_err(|_| StoreError::InvalidInput)?
            .timestamp_millis();
        if c["binding"] != binding || c["expires"].as_i64().unwrap() < now || timestamp > now + 5000
        {
            return Err(invalid(
                "This issue cursor expired or belongs to another query. Refresh the list.",
            ));
        }
    }
    let snapshot = if let Some(c) = &cursor {
        text(c, "snapshot").to_owned()
    } else {
        sqlx::query_scalar::<_,String>(r#"SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')"#).fetch_one(&mut *tx).await?
    };
    let expires = cursor
        .as_ref()
        .map_or(now + 15 * 60_000, |c| c["expires"].as_i64().unwrap());
    let normalized = json!({"search":text(input,"search").to_lowercase(),"rules":input["filters"]["rules"].as_array().unwrap().iter().map(|r|json!({"field":r["field"],"operator":r["operator"],"expected":forge_core::text::trim(text(r,"value")).to_lowercase()})).collect::<Vec<_>>()});
    let sql = include_str!("query.sql")
        .replace("{{team}}", &policy::readable_team(&actor, "i.team_id"))
        .replace("{{parent}}", &policy::readable_issue(&actor, "i.parent_id"))
        .replace(
            "{{project}}",
            &policy::readable_project(&actor, "i.project_id"),
        );
    let limit = input["limit"].as_i64().unwrap();
    let mut result: Aggregated = sqlx::query_as(&sql)
        .bind(&actor.workspace_id)
        .bind(policy::privileged(&actor))
        .bind(&actor.user_id)
        .bind(input)
        .bind(&snapshot)
        .bind(normalized)
        .bind(cursor.as_ref().map(|c| &c["values"]))
        .bind(limit)
        .fetch_one(&mut *tx)
        .await?;
    let page = &result.page.0[..result.page.len().min(limit as usize)];
    let ids: Vec<_> = page.iter().map(|r| r.id).collect();
    let mut records = if ids.is_empty() {
        vec![]
    } else {
        read_rows(
            &mut tx,
            &actor,
            Some(&ids),
            database.sla_gate(&actor.workspace_id).0,
        )
        .await?
    };
    records.sort_by_key(|r| {
        ids.iter()
            .position(|id| id.to_string() == text(&r.issue, "id"))
    });
    let mut facets = json!({});
    let mut truncated = result.groups.len() > 500
        || result.rollups.len() > 1000
        || result.project_totals.len() > 1000;
    for name in [
        "assignee", "priority", "project", "team", "status", "labels",
    ] {
        let counts: Vec<_> = result.counts.iter().filter(|c| c.facet == name).collect();
        truncated |= counts.len() > 100;
        facets[name] = json!(
            counts
                .into_iter()
                .take(100)
                .map(|c| json!({"value":c.value,"count":c.count}))
                .collect::<Vec<_>>()
        );
    }
    let next = if result.page.len() > limit as usize {
        let last = page.last().ok_or(StoreError::InvalidInput)?;
        Some(URL_SAFE_NO_PAD.encode(json!({"version":1,"binding":binding,"snapshot":snapshot,"expires":expires,"values":[last.completion_key,last.completion_time,last.sort_key,last.number_key,last.id]}).to_string().as_bytes()))
    } else {
        None
    };
    result.groups.truncate(500);
    result.project_totals.truncate(1000);
    result.rollups.truncate(1000);
    tx.commit().await?;
    Ok(
        json!({"workspaceId":actor.workspace_id,"userId":actor.user_id,"sessionId":session(&actor),"records":records,"resultRevision":result.result_revision,"projectTotals":result.project_totals.0,"rollups":result.rollups.0,"nextCursor":next,"total":result.total,"facets":facets,"facetsTruncated":truncated,"groups":result.groups.0}),
    )
}
