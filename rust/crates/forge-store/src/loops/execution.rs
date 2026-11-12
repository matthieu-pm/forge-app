//! Durable claim and settlement surround provider execution. An uncertain start
//! is quarantined, never requeued, and each workspace has one active claim.
use super::*;
use forge_core::{actor::LoopScope, security::SecurityAction};
use std::time::Duration;
mod cloud;

#[derive(Clone, Debug, FromRow)]
pub struct ClaimedRun {
    pub id: Uuid,
    pub workspace_id: String,
    pub loop_id: Uuid,
    pub loop_revision: i32,
    pub team_id: Uuid,
    pub event: Value,
    pub fields: Value,
    pub thread_id: Uuid,
    pub agent_run_id: Uuid,
    pub pending_decision: Option<Value>,
    pub result: Option<String>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub lease_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutionState {
    Completed,
    WaitingForApproval,
    Failed,
    Cancelled,
}
impl ExecutionState {
    fn text(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::WaitingForApproval => "waiting-for-approval",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}
#[derive(Debug)]
pub struct ExecutionResult {
    pub state: ExecutionState,
    pub result: Option<String>,
    pub error_code: Option<String>,
}
#[async_trait::async_trait]
pub trait Executor: Send + Sync {
    async fn execute(
        &self,
        actor: Actor,
        run: ClaimedRun,
        context: Value,
    ) -> Result<ExecutionResult, StoreError>;
}
impl ClaimedRun {
    fn cancelling(&self) -> bool {
        self.pending_decision
            .as_ref()
            .is_some_and(|v| v["action"] == "cancel-run")
    }
    fn principal(&self) -> Actor {
        Actor {
            workspace_id: self.workspace_id.clone(),
            user_id: contract::principal_id(&self.loop_id.to_string()),
            workspace_role: "member".into(),
            authentication: Authentication::Loop {
                loop_id: self.loop_id.to_string(),
                run_id: self.id.to_string(),
            },
            scopes: None,
            loop_scope: None,
        }
    }
    fn deadline(&self) -> i64 {
        self.started_at
            .or(self.lease_at)
            .unwrap_or(self.created_at)
            .timestamp_millis()
            .saturating_add(contract::RUN_WALL_CLOCK_MS)
    }
}
impl Service {
    async fn claim(&self, workspace: Option<&str>) -> Result<Option<ClaimedRun>, StoreError> {
        if !self.options.enabled {
            return Ok(None);
        }
        let mut tx = self.database.begin().await?;
        let row:Option<ClaimedRun>=sqlx::query_as("SELECT r.*,l.team_id FROM loop_runs r JOIN team_loops l ON l.id=r.loop_id AND l.workspace_id=r.workspace_id WHERE ($1::text IS NULL OR r.workspace_id=$1) AND (r.state='queued' OR (r.state='waiting-for-approval' AND r.pending_decision IS NOT NULL) OR (r.state='running' AND r.pending_decision->>'action'='cancel-run')) AND (r.pending_decision->>'action'='cancel-run' OR NOT EXISTS(SELECT 1 FROM loop_runs busy WHERE busy.workspace_id=r.workspace_id AND busy.id<>r.id AND (busy.state='running' OR (busy.state='uncertain' AND COALESCE(busy.lease_at,busy.started_at,busy.created_at)+($2::bigint*interval '1 millisecond')>clock_timestamp())))) ORDER BY r.created_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED")
            .bind(workspace).bind(contract::RUN_LEASE_MS).fetch_optional(&mut *tx).await?;
        let Some(mut run) = row else {
            tx.commit().await?;
            return Ok(None);
        };
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,6200))")
            .bind(&run.workspace_id)
            .execute(&mut *tx)
            .await?;
        let busy:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM loop_runs WHERE workspace_id=$1 AND id<>$2 AND (state='running' OR (state='uncertain' AND COALESCE(lease_at,started_at,created_at)+($3::bigint*interval '1 millisecond')>clock_timestamp())))").bind(&run.workspace_id).bind(run.id).bind(contract::RUN_LEASE_MS).fetch_one(&mut *tx).await?;
        if !run.cancelling() && busy {
            tx.commit().await?;
            return Ok(None);
        }
        let now = self.time();
        run.started_at = Some(run.started_at.unwrap_or(now));
        run.lease_at = Some(now);
        tx.prepare().await?;
        sqlx::query("UPDATE loop_runs SET state='running',started_at=$2,lease_at=$3 WHERE id=$1")
            .bind(run.id)
            .bind(run.started_at)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(Some(run))
    }
    async fn execution_context(&self, run: &mut ClaimedRun) -> Result<(Actor, Value), StoreError> {
        let mut tx = self.database.begin().await?;
        // Management locks workspace/definition before run; follow that order
        // when refreshing a concurrent cancellation and checking its authority.
        fence(&mut tx, &run.principal()).await?;
        sqlx::query("SELECT id FROM team_loops WHERE id=$1 AND workspace_id=$2 FOR SHARE")
            .bind(run.loop_id)
            .bind(&run.workspace_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(StoreError::Forbidden)?;
        let pending: Option<Value> =
            sqlx::query_scalar("SELECT pending_decision FROM loop_runs WHERE id=$1 FOR UPDATE")
                .bind(run.id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(StoreError::Forbidden)?;
        if pending
            .as_ref()
            .is_some_and(|v| v["action"] == "cancel-run")
        {
            run.pending_decision = pending;
        }
        if !run.cancelling() && self.time().timestamp_millis() >= run.deadline() {
            return Err(StoreError::LoopPolicy("UNCERTAIN_EXECUTION_TIMEOUT"));
        }
        let mut candidate = run.principal();
        if run.cancelling() {
            candidate.loop_scope = Some(LoopScope {
                loop_id: run.loop_id.to_string(),
                run_id: run.id.to_string(),
                team_id: run.team_id.to_string(),
                all_public: false,
                cancelling: true,
            });
        }
        let actor = authority::current(
            &mut tx,
            &candidate,
            &run.id.to_string(),
            self.options.enabled,
            self.time(),
        )
        .await?;
        if run
            .pending_decision
            .as_ref()
            .is_some_and(|v| v["approvalId"].is_string())
        {
            reviewer(&mut tx, &actor, run).await?;
        }
        let context = if run.cancelling() {
            json!({})
        } else if let (Some(entity), Some(entity_id)) =
            (run.event["entity"].as_str(), run.event["entityId"].as_str())
        {
            let raw = context::current(&mut tx, &actor, entity, id(entity_id)?, run.team_id, false)
                .await?;
            let mut context = json!({"event":run.event.get("kind").cloned().unwrap_or(json!("event")),"entity":entity,"trigger":run.event.get("trigger").or_else(||run.event.get("kind")).cloned().unwrap_or(json!("event")),"context":contract::normalize_snapshot(entity,&raw)});
            context.as_object_mut().unwrap().extend(
                contract::activity_context(&raw, &run.event)
                    .map_err(|_| StoreError::Forbidden)?
                    .as_object()
                    .ok_or(StoreError::InvalidInput)?
                    .clone(),
            );
            context
        } else {
            run.event.clone()
        };
        tx.commit().await?;
        Ok((actor, context))
    }
    pub async fn execute_next(&self, workspace: Option<&str>) -> Result<Option<Uuid>, StoreError> {
        self.execute_next_with(&cloud::Cloud(self.clone()), workspace)
            .await
    }
    pub async fn execute_next_with(
        &self,
        executor: &dyn Executor,
        workspace: Option<&str>,
    ) -> Result<Option<Uuid>, StoreError> {
        let Some(mut run) = self.claim(workspace).await? else {
            return Ok(None);
        };
        let result = async {
            let (actor, context) = self.execution_context(&mut run).await?;
            let deadline = if run.cancelling() {
                run.lease_at
                    .unwrap()
                    .timestamp_millis()
                    .saturating_add(contract::CANCEL_SETTLEMENT_MS)
            } else {
                run.deadline().saturating_add(contract::SETTLEMENT_GRACE_MS)
            };
            let remaining = deadline
                .saturating_sub(self.time().timestamp_millis())
                .max(0) as u64;
            tokio::time::timeout(
                Duration::from_millis(remaining),
                executor.execute(actor, run.clone(), context),
            )
            .await
            .map_err(|_| StoreError::LoopPolicy("UNCERTAIN_EXECUTION_TIMEOUT"))?
        }
        .await;
        let mut tx = self.database.begin().await?;
        let latest: Option<Value> = sqlx::query_scalar(
            "SELECT pending_decision FROM loop_runs WHERE id=$1 AND state='running' FOR UPDATE",
        )
        .bind(run.id)
        .fetch_optional(&mut *tx)
        .await?
        .unwrap_or(None);
        tx.prepare().await?;
        match result {
            Ok(result) => {
                sqlx::query("UPDATE loop_runs SET state=$2,result=$3,error_code=$4,pending_decision=CASE WHEN $2='waiting-for-approval' THEN CASE WHEN pending_decision IS NOT DISTINCT FROM $5::jsonb THEN NULL ELSE pending_decision END ELSE NULL END,finished_at=CASE WHEN $2='waiting-for-approval' THEN NULL ELSE $6 END,lease_at=NULL WHERE id=$1 AND state='running'")
                    .bind(run.id).bind(result.state.text()).bind(result.result.map(|s|bounded(&s,100_000))).bind(result.error_code).bind(&run.pending_decision).bind(self.time()).execute(&mut *tx).await?;
            }
            Err(_)
                if !run.cancelling()
                    && latest.as_ref().is_some_and(|v| v["action"] == "cancel-run") =>
            {
                sqlx::query("UPDATE loop_runs SET state='waiting-for-approval',lease_at=NULL,error_code=NULL WHERE id=$1 AND state='running'").bind(run.id).execute(&mut *tx).await?;
            }
            Err(error) => {
                let agent: Option<String> =
                    sqlx::query_scalar("SELECT state FROM agent_runs WHERE id=$1")
                        .bind(run.agent_run_id)
                        .fetch_optional(&mut *tx)
                        .await?;
                let revoked = matches!(&error, StoreError::LoopPolicy("REVIEWER_ACCESS_REVOKED"));
                let uncertain = matches!(&error,StoreError::LoopPolicy(s)if s.starts_with("UNCERTAIN"))
                    || agent
                        .as_deref()
                        .is_some_and(|s| !matches!(s, "completed" | "failed" | "cancelled"));
                let (state, code) = if revoked {
                    ("waiting-for-approval", "REVIEWER_ACCESS_REVOKED")
                } else if uncertain {
                    ("uncertain", "DISPATCH_REQUIRES_RECONCILIATION")
                } else if matches!(error, StoreError::Forbidden) {
                    ("blocked", "ACCESS_REVOKED")
                } else {
                    ("failed", "EXECUTION_FAILED")
                };
                sqlx::query("UPDATE loop_runs SET state=$2,error_code=$3,pending_decision=NULL,finished_at=CASE WHEN $2='waiting-for-approval' THEN NULL ELSE $4 END,lease_at=NULL WHERE id=$1 AND state='running'").bind(run.id).bind(state).bind(code).bind(self.time()).execute(&mut *tx).await?;
            }
        }
        tx.commit().await?;
        Ok(Some(run.id))
    }
}
pub(crate) async fn decision_reviewer(
    c: &mut PgConnection,
    actor: &Actor,
    run_id: Uuid,
    approval: Uuid,
    action: &str,
) -> Result<String, StoreError> {
    let scope = actor.loop_scope.as_ref().ok_or(StoreError::Forbidden)?;
    if scope.run_id != run_id.to_string() {
        return Err(StoreError::Forbidden);
    }
    let run:ClaimedRun=sqlx::query_as("SELECT r.*,l.team_id FROM loop_runs r JOIN team_loops l ON l.id=r.loop_id AND l.workspace_id=r.workspace_id WHERE r.id=$1 AND r.workspace_id=$2")
        .bind(run_id).bind(&actor.workspace_id).fetch_optional(&mut *c).await?.ok_or(StoreError::Forbidden)?;
    if !run
        .pending_decision
        .as_ref()
        .is_some_and(|p| p["approvalId"] == approval.to_string() && p["action"] == action)
    {
        return Err(StoreError::Forbidden);
    }
    reviewer(c, actor, &run).await
}
async fn reviewer(
    c: &mut PgConnection,
    actor: &Actor,
    run: &ClaimedRun,
) -> Result<String, StoreError> {
    let denied = || StoreError::LoopPolicy("REVIEWER_ACCESS_REVOKED");
    let user = run
        .pending_decision
        .as_ref()
        .and_then(|d| d["requestedById"].as_str())
        .ok_or_else(denied)?;
    let role: String = sqlx::query_scalar(
        "SELECT role FROM member WHERE organization_id=$1 AND user_id=$2 FOR SHARE",
    )
    .bind(&run.workspace_id)
    .bind(user)
    .fetch_optional(&mut *c)
    .await?
    .ok_or_else(denied)?;
    // This is the locked membership grant, not an authenticated user session.
    // It is only used for the resource and workspace policy checks below.
    let reviewer = Actor {
        user_id: user.into(),
        workspace_role: role,
        loop_scope: None,
        ..actor.clone()
    };
    policy::team(c, &reviewer, run.team_id).await.map_err(|e| {
        if matches!(e, StoreError::Forbidden) {
            denied()
        } else {
            e
        }
    })?;
    if !security::settings(c, &run.workspace_id)
        .await?
        .allows(&reviewer, SecurityAction::AgentsInvoke)
    {
        return Err(denied());
    }
    Ok(user.into())
}
fn bounded(text: &str, maximum: usize) -> String {
    let mut length = 0;
    text.chars()
        .take_while(|c| {
            length += c.len_utf16();
            length <= maximum
        })
        .collect()
}
