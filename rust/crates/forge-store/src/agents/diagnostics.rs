use crate::{Database, StoreError, authority::current_actor};
use chrono::{DateTime, SecondsFormat, Utc};
use forge_core::actor::{Actor, ApiScope};
use serde_json::{Value, json};
pub async fn read(
    db: &Database,
    actor: &Actor,
    since: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<Value, StoreError> {
    let mut tx = db.begin().await?;
    let actor = current_actor(&mut tx, actor).await?;
    if !actor.has_scope(ApiScope::AgentsRead) || !actor.has_role(&["owner", "admin"]) {
        return Err(StoreError::Forbidden);
    }
    let queries = [
        (
            "runs",
            "SELECT jsonb_build_object('id',r.id,'state',r.state,'executionKind',r.execution_kind,'requestedSelection',r.requested_selection,'resolvedModelId',r.resolved_model_id,'reasoningEffort',r.reasoning_effort,'routingReason',r.routing_reason,'inputTokens',r.input_tokens,'outputTokens',r.output_tokens,'cachedInputTokens',r.cached_input_tokens,'costMicros',r.cost_micros,'createdAt',r.created_at,'startedAt',r.started_at,'completedAt',r.completed_at)::text FROM agent_runs r JOIN agent_threads t ON t.id=r.thread_id WHERE t.workspace_id=$1 AND r.created_at >= $2 ORDER BY r.created_at,r.id",
        ),
        (
            "events",
            "SELECT jsonb_build_object('runId',e.run_id,'type',e.type,'payload',jsonb_build_object('state',e.payload_json->'state','toolName',e.payload_json->'toolName'),'occurredAt',e.occurred_at)::text FROM agent_events e JOIN agent_threads t ON t.id=e.thread_id WHERE t.workspace_id=$1 AND e.occurred_at >= $2 ORDER BY e.run_id,e.sequence",
        ),
        (
            "approvals",
            "SELECT jsonb_build_object('state',state)::text FROM agent_approvals WHERE workspace_id=$1 AND requested_at >= $2",
        ),
        (
            "invocations",
            "SELECT jsonb_build_object('outcome',outcome,'durationMs',duration_ms)::text FROM agent_capability_invocations WHERE workspace_id=$1 AND created_at >= $2",
        ),
    ];
    let mut input = json!({"since":since.to_rfc3339_opts(SecondsFormat::Millis,true)});
    for (key, query) in queries {
        let rows: Vec<String> = sqlx::query_scalar(query)
            .bind(&actor.workspace_id)
            .bind(since)
            .fetch_all(&mut *tx)
            .await?;
        input[key] = Value::Array(
            rows.iter()
                .map(|s| forge_core::json::parse(s).map_err(|_| StoreError::InvalidInput))
                .collect::<Result<_, _>>()?,
        );
    }
    let result = forge_core::agents::diagnostics::summarize(
        &input,
        &now.to_rfc3339_opts(SecondsFormat::Millis, true),
    );
    tx.commit().await?;
    Ok(result)
}
