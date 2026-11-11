//! Current authority and exact invocation binding around the approval ledger.
//! Requests/resolutions and their events commit together. Consumption can join a
//! canonical command transaction, so a failed write cannot spend its approval.
use super::{Approval, ApprovalState, Event, Risk, approvals, events, runs};
use crate::{Database, StoreError, authority::current_actor, database::JournalTransaction};
use chrono::{DateTime, Duration, Utc};
use forge_core::{
    actor::{Actor, ApiScope, Authentication},
    agents::approval::{self, Code, Error},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct Request {
    pub approval_id: Option<Uuid>,
    pub run_id: Uuid,
    pub capability_id: String,
    pub capability_version: String,
    pub risk: Risk,
    pub input: Value,
    pub redacted_input_summary: Value,
    pub expires_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug)]
pub struct Binding {
    pub run_id: Uuid,
    pub capability_id: String,
    pub capability_version: String,
    pub capability_input: Value,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Approved,
    Denied,
}
#[derive(Debug, Serialize)]
pub struct Resolution {
    pub approval: Approval,
    pub event: Event,
}

#[derive(Clone)]
pub struct Service {
    database: Database,
    now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    ttl: Duration,
}
impl Service {
    pub fn new(database: Database) -> Self {
        Self {
            database,
            now: Arc::new(Utc::now),
            ttl: Duration::minutes(5),
        }
    }
    pub fn with_clock(mut self, now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>) -> Self {
        self.now = now;
        self
    }
    pub fn with_ttl(mut self, ttl: Duration) -> Self {
        self.ttl = ttl;
        self
    }
    fn now(&self) -> DateTime<Utc> {
        // The source clock is a JavaScript Date, including millisecond precision.
        DateTime::from_timestamp_millis((self.now)().timestamp_millis()).unwrap()
    }
    async fn begin(&self, actor: &Actor) -> Result<(JournalTransaction, Actor), StoreError> {
        let mut tx = self.database.begin().await?;
        // Follow canonical command lock order, including for simultaneous agent
        // requests that otherwise upgrade shared run locks in opposite order.
        let exists: Option<String> =
            sqlx::query_scalar("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
                .bind(&actor.workspace_id)
                .fetch_optional(&mut *tx)
                .await?;
        if exists.is_none() {
            return Err(StoreError::Forbidden);
        }
        let actor = current_actor(&mut tx, actor).await?;
        Ok((tx, actor))
    }
    pub async fn request(&self, actor: &Actor, input: &Request) -> Result<Resolution, StoreError> {
        let (mut tx, actor) = self.begin(actor).await?;
        let result = self.request_in(&mut tx, &actor, input).await?;
        tx.commit().await?;
        Ok(result)
    }
    /// Caller holds the workspace fence and has resolved current actor authority.
    pub(crate) async fn request_in(
        &self,
        tx: &mut JournalTransaction,
        actor: &Actor,
        input: &Request,
    ) -> Result<Resolution, StoreError> {
        if !actor.has_scope(ApiScope::AgentsWrite) {
            return Err(StoreError::Forbidden);
        }
        let run = runs::get_in(tx, &actor.workspace_id, input.run_id)
            .await?
            .filter(|run| {
                run.initiated_by_user_id == actor.user_id && agent_run_matches(actor, run.id)
            })
            .ok_or_else(|| {
                error(
                    Code::ApprovalBindingMismatch,
                    "The approval request is not bound to this user and run.",
                )
            })?;
        let now = self.now();
        let record = Approval {
            id: input.approval_id.unwrap_or_else(Uuid::new_v4),
            workspace_id: actor.workspace_id.clone(),
            run_id: run.id,
            requested_for_user_id: actor.user_id.clone(),
            capability_id: input.capability_id.clone(),
            capability_version: input.capability_version.clone(),
            risk: input.risk,
            input_hash: approval::input_hash(&input.input),
            redacted_input_summary: input.redacted_input_summary.clone(),
            state: ApprovalState::Pending,
            nonce: Uuid::new_v4().to_string(),
            requested_at: now,
            expires_at: input.expires_at.unwrap_or(now + self.ttl),
            resolved_at: None,
            resolved_by_user_id: None,
        };
        let approval = approvals::create(tx, &record).await?;
        if approval.workspace_id != record.workspace_id
            || approval.run_id != record.run_id
            || approval.requested_for_user_id != record.requested_for_user_id
            || approval.capability_id != record.capability_id
            || approval.capability_version != record.capability_version
            || approval.input_hash != record.input_hash
        {
            return Err(error(
                Code::ApprovalBindingMismatch,
                "The approval identifier was already used for another request.",
            ));
        }
        let event=events::append_in(tx,json!({"threadId":run.thread_id,"runId":run.id,"sourceEventId":format!("approval:{}:requested",approval.id),"occurredAt":iso(approval.requested_at),"source":"forge","type":"approval.requested","schemaVersion":1,
            "payload":{"approvalId":approval.id,"capabilityId":approval.capability_id,"capabilityVersion":approval.capability_version,"risk":approval.risk,"inputHash":approval.input_hash,"summary":approval.redacted_input_summary,"expiresAt":iso(approval.expires_at)}})).await?;
        sqlx::query("UPDATE agent_runs SET state='waiting-for-approval',updated_at=$2 WHERE id=$1")
            .bind(run.id)
            .bind(now)
            .execute(&mut **tx)
            .await?;
        Ok(Resolution { approval, event })
    }
    pub async fn resolve(
        &self,
        actor: &Actor,
        id: Uuid,
        decision: Decision,
    ) -> Result<Resolution, StoreError> {
        let (mut tx, actor) = self.begin(actor).await?;
        if !actor.has_scope(ApiScope::AgentsApprove) {
            return Err(StoreError::Forbidden);
        }
        let existing = bound(&mut tx, &actor, id).await?;
        let now = self.now();
        if existing.expires_at <= now {
            if existing.state == ApprovalState::Pending {
                approvals::compare_and_set(
                    &mut tx,
                    id,
                    ApprovalState::Pending,
                    ApprovalState::Expired,
                    Some(now),
                    Some(&actor.user_id),
                )
                .await?;
            }
            tx.commit().await?;
            return Err(error(
                Code::ApprovalExpired,
                "This approval request has expired.",
            ));
        }
        if existing.state != ApprovalState::Pending {
            return Err(error(
                Code::ApprovalNotPending,
                "This approval request has already been resolved.",
            ));
        }
        let next = match decision {
            Decision::Approved => ApprovalState::Approved,
            Decision::Denied => ApprovalState::Denied,
        };
        let approval = approvals::compare_and_set(
            &mut tx,
            id,
            ApprovalState::Pending,
            next,
            Some(now),
            Some(&actor.user_id),
        )
        .await?
        .ok_or_else(|| {
            error(
                Code::ApprovalNotPending,
                "This approval request has already been resolved.",
            )
        })?;
        let run = runs::get_in(&mut tx, &actor.workspace_id, approval.run_id)
            .await?
            .ok_or_else(|| {
                error(
                    Code::ApprovalBindingMismatch,
                    "The approval run is unavailable.",
                )
            })?;
        let event=events::append_in(&mut tx,json!({"threadId":run.thread_id,"runId":run.id,"sourceEventId":format!("approval:{}:resolved",approval.id),"occurredAt":iso(now),"source":"forge","type":"approval.resolved","schemaVersion":1,
            "payload":{"approvalId":approval.id,"decision":decision,"inputHash":approval.input_hash}})).await?;
        // A denial resumes the turn with a denied tool result, as in the source.
        sqlx::query("UPDATE agent_runs SET state='running',updated_at=$2 WHERE id=$1")
            .bind(run.id)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(Resolution { approval, event })
    }
    pub async fn consume(
        &self,
        actor: &Actor,
        id: Uuid,
        input: &Binding,
    ) -> Result<Approval, StoreError> {
        let (mut tx, actor) = self.begin(actor).await?;
        tx.prepare().await?;
        let approval = consume_in(&mut tx, &actor, id, input, self.now()).await?;
        tx.commit().await?;
        Ok(approval)
    }
    pub async fn find_approved(
        &self,
        actor: &Actor,
        input: &Binding,
    ) -> Result<Option<Approval>, StoreError> {
        let (mut tx, actor) = self.begin(actor).await?;
        let approval = find_approved_in(&mut tx, &actor, input, self.now()).await?;
        tx.commit().await?;
        Ok(approval)
    }
}
fn error(code: Code, message: &'static str) -> StoreError {
    Error::new(code, message).into()
}
fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn agent_run_matches(actor: &Actor, run: Uuid) -> bool {
    match &actor.authentication {
        Authentication::Agent { run_id, .. } => run_id.parse::<Uuid>().ok() == Some(run),
        _ => true,
    }
}
async fn bound(
    connection: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
) -> Result<Approval, StoreError> {
    let approval = approvals::get(connection, id).await?.ok_or_else(|| {
        error(
            Code::ApprovalNotFound,
            "The approval request was not found.",
        )
    })?;
    if approval.workspace_id != actor.workspace_id
        || approval.requested_for_user_id != actor.user_id
    {
        return Err(error(
            Code::ApprovalBindingMismatch,
            "The approval is not bound to this user and workspace.",
        ));
    }
    if !agent_run_matches(actor, approval.run_id) {
        return Err(error(
            Code::ApprovalBindingMismatch,
            "The approval is not bound to this agent run.",
        ));
    }
    Ok(approval)
}
fn grant(approval: &Approval, input: &Binding) -> bool {
    approval::program_grant_allows(
        &approval.capability_id,
        &approval.redacted_input_summary,
        &input.capability_id,
        &input.capability_version,
    )
}
/// For canonical SQL commands only: the caller must already reauthorize the
/// actor/target and prepare the deletion journal on this same transaction.
pub(crate) async fn consume_in(
    connection: &mut PgConnection,
    actor: &Actor,
    id: Uuid,
    input: &Binding,
    now: DateTime<Utc>,
) -> Result<Approval, StoreError> {
    let approval = bound(connection, actor, id).await?;
    let is_program = grant(&approval, input);
    if approval.run_id != input.run_id
        || (!is_program
            && (approval.capability_id != input.capability_id
                || approval.capability_version != input.capability_version
                || approval.input_hash != approval::input_hash(&input.capability_input)))
    {
        return Err(error(
            Code::ApprovalBindingMismatch,
            "The approval does not match this exact capability invocation.",
        ));
    }
    if approval.expires_at <= now {
        return Err(error(
            Code::ApprovalExpired,
            "This approval request has expired.",
        ));
    }
    if approval.state != ApprovalState::Approved {
        return Err(error(
            Code::ApprovalNotApproved,
            "This approval is not approved or has already been consumed.",
        ));
    }
    if is_program {
        return Ok(approval);
    }
    approvals::compare_and_set_in(
        connection,
        id,
        ApprovalState::Approved,
        ApprovalState::Consumed,
        None,
        None,
    )
    .await?
    .ok_or_else(|| {
        error(
            Code::ApprovalNotApproved,
            "This approval has already been consumed.",
        )
    })
}
pub(crate) async fn find_approved_in(
    connection: &mut PgConnection,
    actor: &Actor,
    input: &Binding,
    now: DateTime<Utc>,
) -> Result<Option<Approval>, StoreError> {
    let exact = approvals::find_approved(
        connection,
        &approvals::ApprovedQuery {
            workspace_id: &actor.workspace_id,
            run_id: input.run_id,
            requested_for_user_id: &actor.user_id,
            capability_id: &input.capability_id,
            capability_version: &input.capability_version,
            input_hash: &approval::input_hash(&input.capability_input),
        },
    )
    .await?;
    let matching = if exact.is_some() {
        exact
    } else {
        approvals::list_program_grants(
            connection,
            &actor.workspace_id,
            input.run_id,
            &actor.user_id,
        )
        .await?
        .into_iter()
        .find(|approval| grant(approval, input))
    };
    Ok(matching
        .filter(|approval| agent_run_matches(actor, approval.run_id) && approval.expires_at > now))
}
