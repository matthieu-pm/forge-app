use super::*;
use crate::{security, workspaces::lock_workspace};
use forge_core::{
    actor::{Actor, Authentication},
    security::SecurityAction,
};

#[derive(sqlx::FromRow)]
struct Subject {
    id: String,
    email: String,
    role: String,
    status: String,
    expires_at: DateTime<Utc>,
    inviter_id: String,
    organization_name: String,
    inviter_name: String,
    inviter_email: String,
}
impl Subject {
    fn message(&self) -> Invitation {
        Invitation {
            id: self.id.clone(),
            email: self.email.clone(),
            role: self.role.clone(),
            organization_name: self.organization_name.clone(),
            inviter_name: if self.inviter_name.is_empty() {
                self.inviter_email.clone()
            } else {
                self.inviter_name.clone()
            },
            inviter_email: self.inviter_email.clone(),
        }
    }
}
async fn subject(tx: &mut PgConnection, input: &Input) -> Result<Subject> {
    sqlx::query_as("SELECT i.id,i.email,coalesce(i.role,'member') AS role,i.status,i.expires_at,i.inviter_id,o.name AS organization_name,u.name AS inviter_name,u.email AS inviter_email FROM business_workflow_runs r JOIN invitation i ON i.id=r.subject_id AND i.organization_id=r.workspace_id JOIN organization o ON o.id=i.organization_id JOIN \"user\" u ON u.id=i.inviter_id WHERE r.id=$1 AND r.workspace_id=$2 AND r.subject_type='invitation' FOR SHARE OF i,u")
        .bind(input.business_run_id).bind(&input.workspace_id).fetch_optional(tx).await.map_err(failed)?.ok_or(Error::permanent(Code::JobFailed))
}
async fn authorize(tx: &mut PgConnection, input: &Input, subject: &Subject) -> Result<()> {
    if subject.status != "pending" || subject.expires_at <= now(tx).await? {
        return Err(Error::permanent(Code::JobFailed));
    }
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM member WHERE organization_id=$1 AND user_id=$2 FOR SHARE",
    )
    .bind(&input.workspace_id)
    .bind(&subject.inviter_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(failed)?;
    let actor = Actor {
        user_id: subject.inviter_id.clone(),
        workspace_id: input.workspace_id.clone(),
        workspace_role: role.ok_or(Error::permanent(Code::JobFailed))?,
        authentication: Authentication::Session {
            session_id: "internal-invitation-workflow".into(),
        },
        scopes: None,
        loop_scope: None,
    };
    if !actor.has_role(&["owner", "admin"])
        || !security::settings(tx, &input.workspace_id)
            .await
            .map_err(failed)?
            .allows(&actor, SecurityAction::MembersInvite)
    {
        return Err(Error::permanent(Code::JobFailed));
    }
    Ok(())
}
fn phase(effect: Effect) -> &'static str {
    match effect {
        Effect::Initial => "initial",
        Effect::Reminder => "reminder-24h",
    }
}
type Dispatch = (String, String, Option<DateTime<Utc>>, Option<Value>);

pub(super) async fn run(
    store: &JobStore,
    lease: &Lease,
    input: &Input,
    effect: Effect,
    transport: &dyn Transport,
) -> std::result::Result<Receipt, Failure> {
    let key = phase(effect);
    let external = format!("send:{key}");
    let mut tx = store.transaction().await?;
    JobStore::fence(&mut tx, lease, true).await?;
    let saved: Option<(String, String, Value)> = sqlx::query_as(
        "SELECT mode,state,result FROM background_job_steps WHERE job_id=$1 AND key=$2",
    )
    .bind(lease.id)
    .bind(key)
    .fetch_optional(&mut *tx)
    .await
    .map_err(failed)?;
    if let Some((mode, state, result)) = saved {
        if mode != "transactional" || state != "completed" {
            return Err(Code::IdentityConflict.into());
        }
        let receipt =
            serde_json::from_value(result).map_err(|_| Error::permanent(Code::JobFailed))?;
        tx.commit().await.map_err(failed)?;
        return Ok(receipt);
    }
    // Same ordering as workspace mutations; these locks remain held across the
    // bounded provider call in the second transaction, after dispatch is durable.
    lock_workspace(&mut tx, &input.workspace_id, false)
        .await
        .map_err(failed)?;
    owned(&mut tx, lease, input).await?;
    let initial = subject(&mut tx, input).await?;
    let timestamp = now(&mut tx).await?;
    let decision =
        forge_core::invitations::classify(effect, &initial.status, initial.expires_at, timestamp);
    if decision != Decision::Deliver {
        if decision == Decision::Expired {
            sqlx::query("UPDATE invitation SET status='expired' WHERE id=$1 AND organization_id=$2 AND status='pending' AND expires_at<=clock_timestamp()")
                .bind(&initial.id).bind(&input.workspace_id).execute(&mut *tx).await.map_err(failed)?;
        }
        let receipt = Receipt {
            decision,
            expires_at: initial.expires_at,
            completed_at: timestamp,
        };
        checkpoint(&mut tx, lease, key, &receipt).await?;
        tx.commit().await.map_err(failed)?;
        return Ok(receipt);
    }
    authorize(&mut tx, input, &initial).await?;
    let effect_key = effect.key(&initial.id);
    let effect_state: Option<String> = sqlx::query_scalar("SELECT state FROM business_workflow_effects WHERE business_run_id=$1 AND effect_key=$2 FOR UPDATE")
        .bind(input.business_run_id).bind(&effect_key).fetch_optional(&mut *tx).await.map_err(failed)?;
    let step: Option<Dispatch> = sqlx::query_as("SELECT mode,state,idempotency_until,result FROM background_job_steps WHERE job_id=$1 AND key=$2")
        .bind(lease.id).bind(&external).fetch_optional(&mut *tx).await.map_err(failed)?;
    if step.as_ref().is_some_and(|s| s.0 != "provider-idempotent") {
        return Err(Code::IdentityConflict.into());
    }
    if effect_state.as_deref() == Some("completed")
        || step.as_ref().is_some_and(|s| s.1 == "completed")
    {
        // A generic operator resolution may confirm delivery without a provider
        // ID. The recovery audit is its evidence; never repeat the provider call.
        sqlx::query("INSERT INTO business_workflow_effects(business_run_id,effect_key,state,completed_at) VALUES($1,$2,'completed',clock_timestamp()) ON CONFLICT(business_run_id,effect_key) DO UPDATE SET state='completed',failure_code=NULL,completed_at=coalesce(business_workflow_effects.completed_at,clock_timestamp()),updated_at=clock_timestamp()")
            .bind(input.business_run_id).bind(&effect_key).execute(&mut *tx).await.map_err(failed)?;
        sqlx::query("UPDATE background_job_steps SET state='completed',result='null'::jsonb,updated_at=clock_timestamp() WHERE job_id=$1 AND key=$2")
            .bind(lease.id).bind(&external).execute(&mut *tx).await.map_err(failed)?;
        let receipt = Receipt {
            decision: Decision::Deliver,
            expires_at: initial.expires_at,
            completed_at: timestamp,
        };
        checkpoint(&mut tx, lease, key, &receipt).await?;
        tx.commit().await.map_err(failed)?;
        return Ok(receipt);
    }
    let fingerprint = transport.fingerprint(&initial.message(), effect)?;
    if fingerprint.len() != 64 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::permanent(Code::InvalidInput).into());
    }
    let deadline = if let Some((_, state, deadline, metadata)) = &step
        && state == "started"
    {
        if metadata.as_ref().and_then(|m| m["payloadHash"].as_str()) != Some(&fingerprint) {
            return Err(Code::ReconciliationRequired.into());
        }
        deadline.ok_or(Code::ReconciliationRequired)?
    } else {
        timestamp + Duration::hours(24) - Duration::minutes(5)
    };
    if deadline <= timestamp + Duration::seconds(30) {
        return Err(Code::ReconciliationRequired.into());
    }
    sqlx::query("INSERT INTO business_workflow_effects(business_run_id,effect_key,state) VALUES($1,$2,'sending') ON CONFLICT(business_run_id,effect_key) DO UPDATE SET state='sending',failure_code=NULL,updated_at=clock_timestamp()")
        .bind(input.business_run_id).bind(&effect_key).execute(&mut *tx).await.map_err(failed)?;
    sqlx::query("INSERT INTO background_job_steps(job_id,key,mode,state,idempotency_until,result) VALUES($1,$2,'provider-idempotent','started',$3,$4) ON CONFLICT(job_id,key) DO UPDATE SET state='started',idempotency_until=EXCLUDED.idempotency_until,result=EXCLUDED.result,updated_at=clock_timestamp()")
        .bind(lease.id).bind(&external).bind(deadline).bind(json!({"payloadHash":fingerprint})).execute(&mut *tx).await.map_err(failed)?;
    tx.commit().await.map_err(failed)?;

    let mut tx = store.transaction().await?;
    JobStore::fence(&mut tx, lease, true).await?;
    lock_workspace(&mut tx, &input.workspace_id, false)
        .await
        .map_err(failed)?;
    owned(&mut tx, lease, input).await?;
    let current = subject(&mut tx, input).await?;
    if let Err(error) = authorize(&mut tx, input, &current).await {
        sqlx::query("UPDATE business_workflow_effects SET state='failed',failure_code='authorization_revoked',updated_at=clock_timestamp() WHERE business_run_id=$1 AND effect_key=$2")
            .bind(input.business_run_id).bind(&effect_key).execute(&mut *tx).await.map_err(failed)?;
        tx.commit().await.map_err(failed)?;
        return Err(error.into());
    }
    if transport.fingerprint(&current.message(), effect)? != fingerprint
        || deadline <= now(&mut tx).await? + Duration::seconds(30)
    {
        return Err(Code::ReconciliationRequired.into());
    }
    // Dispatch is durable before I/O, and all positive receipts settle together
    // under the still-current job lease and live inviter/workspace locks.
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        transport.deliver(&current.message(), effect),
    )
    .await
    .unwrap_or_else(|_| Err(DeliveryError::provider(None, "application_error")));
    let provider = match response {
        Ok(id) if !id.is_empty() && id.len() <= 1024 && !id.chars().any(char::is_control) => id,
        result => {
            sqlx::query("UPDATE business_workflow_effects SET state='failed',failure_code='email_provider_error',updated_at=clock_timestamp() WHERE business_run_id=$1 AND effect_key=$2")
                .bind(input.business_run_id).bind(&effect_key).execute(&mut *tx).await.map_err(failed)?;
            tx.commit().await.map_err(failed)?;
            return Err(result
                .err()
                .unwrap_or_else(|| DeliveryError::provider(None, "application_error"))
                .into());
        }
    };
    let receipt = Receipt {
        decision: Decision::Deliver,
        expires_at: current.expires_at,
        completed_at: now(&mut tx).await?,
    };
    sqlx::query("UPDATE business_workflow_effects SET state='completed',failure_code=NULL,provider_reference=$3,completed_at=$4,updated_at=clock_timestamp() WHERE business_run_id=$1 AND effect_key=$2")
        .bind(input.business_run_id).bind(&effect_key).bind(provider).bind(receipt.completed_at).execute(&mut *tx).await.map_err(failed)?;
    sqlx::query("UPDATE background_job_steps SET state='completed',result='null'::jsonb,updated_at=clock_timestamp() WHERE job_id=$1 AND key=$2")
        .bind(lease.id).bind(&external).execute(&mut *tx).await.map_err(failed)?;
    checkpoint(&mut tx, lease, key, &receipt).await?;
    JobStore::fence(&mut tx, lease, false).await?;
    tx.commit().await.map_err(failed)?;
    Ok(receipt)
}
