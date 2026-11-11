use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    binding: String,
    time: String,
    id: Uuid,
}
#[derive(FromRow)]
struct Event {
    id: Uuid,
    topic: String,
    time: String,
    created_at: DateTime<Utc>,
    payload: Value,
    actor_user_id: String,
    actor_name: String,
    system: bool,
}
pub async fn history(
    database: &Database,
    actor: &Actor,
    input: Value,
) -> Result<Value, StoreError> {
    let input = contract::history_query(input).map_err(|_| StoreError::InvalidInput)?;
    let issue = id(&input, "issueId")?;
    let limit = input["limit"].as_i64().ok_or(StoreError::InvalidInput)?;
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let actor = current_actor(&mut tx, actor).await?;
    policy::scope(&actor, ApiScope::IssuesRead)?;
    policy::issue(&mut tx, &actor, issue, false).await?;
    let legacy: Option<String> = sqlx::query_scalar("SELECT legacy_id FROM issues WHERE id=$1")
        .bind(issue)
        .fetch_one(&mut *tx)
        .await?;
    let binding=format!("{:x}",Sha256::digest(json!({"workspaceId":actor.workspace_id,"userId":actor.user_id,"authentication":actor.authentication,"issueId":input["issueId"]}).to_string().as_bytes()));
    let cursor = if let Some(encoded) = input
        .get("cursor")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| invalid("Invalid history cursor. Refresh history."))?;
        let cursor: Cursor = serde_json::from_slice(&bytes)
            .map_err(|_| invalid("Invalid history cursor. Refresh history."))?;
        if cursor.version != 1
            || cursor.binding.len() != 64
            || forge_core::text::length(&cursor.time) > 80
        {
            return Err(StoreError::InvalidInput);
        }
        if cursor.binding != binding {
            return Err(invalid("This history cursor belongs to another view."));
        }
        let valid: bool =
            sqlx::query_scalar("SELECT pg_input_is_valid($1,'timestamp with time zone')")
                .bind(&cursor.time)
                .fetch_one(&mut *tx)
                .await?;
        if !valid {
            return Err(invalid("Invalid history cursor. Refresh history."));
        }
        Some(cursor)
    } else {
        None
    };
    let sla = if commands::sla_gate(&actor.workspace_id).0 {
        " UNION ALL SELECT s.id,s.workspace_id,'issue.sla.'||s.kind,s.created_at,jsonb_build_object('issueId',s.issue_id,'changes',s.changes),'' AS actor_user_id,'Forge SLA' AS actor_name,true AS system FROM issue_sla_events s WHERE s.workspace_id=$1 AND s.issue_id=$4"
    } else {
        ""
    };
    let query = format!(
        "SELECT e.id,e.topic,e.created_at::text AS time,e.created_at,e.payload,e.actor_user_id,e.actor_name,e.system FROM (SELECT e.id,e.workspace_id,e.topic,e.created_at,e.payload,a.actor_user_id,coalesce(u.name,'Former member') actor_name,false system FROM command_outbox_events e JOIN command_audit_events a ON a.command_id=e.command_id AND a.workspace_id=e.workspace_id JOIN command_receipts r ON r.id=e.command_id AND r.workspace_id=e.workspace_id AND r.completed_at IS NOT NULL LEFT JOIN \"user\" u ON u.id=a.actor_user_id{sla}) e WHERE e.workspace_id=$1 AND e.payload->>'issueId'=$4::uuid::text AND {} AND e.topic LIKE 'issue.%' AND e.topic<>'issue.comment.mentioned' AND ($5::text IS NULL OR (e.created_at,e.id)<($5::timestamptz,$6::uuid)) ORDER BY e.created_at DESC,e.id DESC LIMIT $7",
        policy::readable_issue("$4")
    );
    let rows: Vec<Event> = sqlx::query_as(&query)
        .bind(&actor.workspace_id)
        .bind(policy::privileged(&actor))
        .bind(&actor.user_id)
        .bind(issue)
        .bind(cursor.as_ref().map(|c| c.time.as_str()))
        .bind(cursor.as_ref().map(|c| c.id))
        .bind(limit + 1)
        .fetch_all(&mut *tx)
        .await?;
    if rows.is_empty() {
        policy::issue(&mut tx, &actor, issue, false).await?;
    }
    let mut entries = Vec::new();
    for e in rows.iter().take(limit as usize) {
        if e.system {
            let details = contract::history_details(
                json!({"version":1,"changes":e.payload["changes"]}),
                false,
            )
            .map_err(|_| StoreError::InvalidInput)?;
            entries.push(json!({"id":e.id,"topic":e.topic,"createdAt":iso(e.created_at),"actor":{"userId":"","name":"Forge SLA","kind":"system"},"origin":"system","changes":details["changes"]}));
            continue;
        }
        let details = contract::history_details(e.payload["history"].clone(), true)
            .ok()
            .filter(|v| v["actor"]["userId"] == e.actor_user_id);
        let mut entry = json!({"id":e.id,"topic":e.topic,"createdAt":iso(e.created_at),"actor":{"userId":e.actor_user_id,"name":details.as_ref().map(|d|text(&d["actor"],"name").to_owned()).unwrap_or_else(||edit::bounded(&e.actor_name,200)),"kind":details.as_ref().map_or("unknown",|d|text(&d["actor"],"kind"))},"origin":details.as_ref().map_or(if e.topic=="issue.created"&&legacy.as_ref().is_some_and(|s|!s.is_empty()){"import"}else{"command"},|d|text(d,"origin")),"changes":details.as_ref().map(|d|d["changes"].clone()).unwrap_or(json!([]))});
        if let Some(comment) = e
            .payload
            .get("commentId")
            .and_then(Value::as_str)
            .filter(|s| forge_core::text::is_uuid(s))
        {
            entry["commentId"] = json!(comment);
        }
        entries.push(entry);
    }
    let next = if rows.len() > limit as usize {
        let last = &rows[limit as usize - 1];
        Some(
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&Cursor {
                    version: 1,
                    binding,
                    time: last.time.clone(),
                    id: last.id,
                })
                .map_err(|_| StoreError::InvalidInput)?,
            ),
        )
    } else {
        None
    };
    tx.commit().await?;
    Ok(json!({"entries":entries,"nextCursor":next}))
}
