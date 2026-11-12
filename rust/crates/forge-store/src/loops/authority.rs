//! A loop's authority belongs to its immutable run and current source, never to
//! the user who configured it. Keep the live definition/run/team locked through
//! the consuming transaction, including command receipt replay.
use super::*;
use forge_core::actor::{API_SCOPES, ApiScope, LoopScope};

#[derive(FromRow)]
struct Grant {
    loop_id: Uuid,
    team_id: Uuid,
    enabled: bool,
    deleted_at: Option<DateTime<Utc>>,
    visibility: String,
    current_fields: Value,
    fields: Value,
    event: Value,
    state: String,
    pending_decision: Option<Value>,
    created_at: DateTime<Utc>,
    started_at: Option<DateTime<Utc>>,
    lease_at: Option<DateTime<Utc>>,
    agent_run_id: Uuid,
}

pub(crate) async fn current(
    c: &mut PgConnection,
    actor: &Actor,
    run_id: &str,
    enabled: bool,
    now: DateTime<Utc>,
) -> Result<Actor, StoreError> {
    if !enabled {
        return Err(StoreError::Forbidden);
    }
    let run = id(run_id).map_err(|_| StoreError::Forbidden)?;
    let row: Grant = sqlx::query_as("SELECT r.loop_id,l.team_id,l.enabled,l.deleted_at,t.visibility,l.fields AS current_fields,r.fields,r.event,r.state,r.pending_decision,r.created_at,r.started_at,r.lease_at,r.agent_run_id FROM loop_runs r JOIN team_loops l ON l.id=r.loop_id AND l.workspace_id=r.workspace_id JOIN teams t ON t.id=l.team_id AND t.workspace_id=l.workspace_id WHERE r.id=$1 AND r.workspace_id=$2 AND t.deleted_at IS NULL FOR SHARE OF r,l,t")
        .bind(run).bind(&actor.workspace_id).fetch_optional(&mut *c).await?.ok_or(StoreError::Forbidden)?;
    let bound = match &actor.authentication {
        Authentication::Loop {
            loop_id,
            run_id: claimed,
        } => loop_id == &row.loop_id.to_string() && claimed == run_id,
        Authentication::Agent { run_id, .. } => run_id == &row.agent_run_id.to_string(),
        _ => false,
    };
    let pending_cancel = row
        .pending_decision
        .as_ref()
        .is_some_and(|v| v["action"] == "cancel-run");
    let cancelling = matches!(actor.authentication, Authentication::Loop { .. })
        && actor.loop_scope.as_ref().is_some_and(|s| s.cancelling)
        && pending_cancel;
    let started = row.started_at.or(row.lease_at).unwrap_or(row.created_at);
    if !bound
        || actor.user_id != contract::principal_id(&row.loop_id.to_string())
        || !matches!(row.state.as_str(), "running" | "waiting-for-approval")
        || (pending_cancel && !cancelling)
        || (!cancelling
            && (!row.enabled
                || row.deleted_at.is_some()
                || now.timestamp_millis() - started.timestamp_millis()
                    >= contract::RUN_WALL_CLOCK_MS))
    {
        return Err(StoreError::Forbidden);
    }
    if !cancelling && row.event["kind"] == "webhook" {
        let external:Option<bool>=sqlx::query_scalar("SELECT external_loop_sources_enabled FROM workspace_security_settings WHERE workspace_id=$1 FOR SHARE").bind(&actor.workspace_id).fetch_optional(&mut *c).await?;
        if external != Some(true) {
            return Err(StoreError::Forbidden);
        }
    }
    let all_public = row.visibility == "workspace"
        && row.fields["teamAccess"] == "all-public-teams"
        && row.current_fields["teamAccess"] == "all-public-teams";
    let scopes = if cancelling {
        vec![ApiScope::AgentsRead, ApiScope::AgentsWrite]
    } else {
        API_SCOPES
            .into_iter()
            .filter(|scope| {
                *scope != ApiScope::ModelConnectionsWrite
                    && actor
                        .scopes
                        .as_ref()
                        .is_none_or(|scopes| scopes.contains(scope))
            })
            .collect()
    };
    let scoped = Actor {
        workspace_role: "member".into(),
        scopes: Some(scopes),
        loop_scope: Some(LoopScope {
            loop_id: row.loop_id.to_string(),
            run_id: run.to_string(),
            team_id: row.team_id.to_string(),
            all_public,
            cancelling,
        }),
        ..actor.clone()
    };
    if !cancelling
        && let (Some(entity), Some(entity_id)) =
            (row.event["entity"].as_str(), row.event["entityId"].as_str())
        && contract::ENTITIES.contains(&entity)
    {
        let raw = context::authorized(
            c,
            &scoped,
            entity,
            id(entity_id).map_err(|_| StoreError::Forbidden)?,
            row.team_id,
            all_public,
        )
        .await?;
        contract::activity_context(&raw, &row.event).map_err(|_| StoreError::Forbidden)?;
    }
    Ok(scoped)
}

pub(crate) async fn current_from_env(
    c: &mut PgConnection,
    actor: &Actor,
    run_id: &str,
) -> Result<Actor, StoreError> {
    current(c, actor, run_id, Options::from_env().enabled, Utc::now()).await
}

impl Service {
    /// Revalidate an internal claimed-run principal using this worker's feature
    /// gate and clock. Runtime callbacks additionally pass general agent-run
    /// authority through crate::authority::current_actor.
    pub async fn authorize_actor(&self, actor: &Actor) -> Result<Actor, StoreError> {
        let Authentication::Loop { run_id, .. } = &actor.authentication else {
            return Err(StoreError::Forbidden);
        };
        let mut tx = self.database.begin().await?;
        let scoped = current(&mut tx, actor, run_id, self.options.enabled, self.time()).await?;
        tx.commit().await?;
        Ok(scoped)
    }
}

/// Even internal loop callers must target the one agent run captured by their
/// loop run. Sharing a synthetic user ID across occurrences does not grant access
/// to another occurrence's approvals or artifacts.
pub(crate) async fn agent_run_matches(
    c: &mut PgConnection,
    actor: &Actor,
    run: Uuid,
) -> Result<bool, StoreError> {
    if let Authentication::Agent { run_id, .. } = &actor.authentication
        && run_id.parse::<Uuid>().ok() != Some(run)
    {
        return Ok(false);
    }
    if let Some(scope) = &actor.loop_scope {
        let (Ok(loop_id), Ok(run_id)) = (id(&scope.loop_id), id(&scope.run_id)) else {
            return Ok(false);
        };
        return Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM loop_runs WHERE id=$1 AND loop_id=$2 AND workspace_id=$3 AND agent_run_id=$4)").bind(run_id).bind(loop_id).bind(&actor.workspace_id).bind(run).fetch_one(c).await?);
    }
    Ok(!matches!(actor.authentication, Authentication::Loop { .. }))
}
