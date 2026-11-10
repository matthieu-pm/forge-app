//! Workspace policy mutations share the organization lock with membership
//! changes. DNS is resolved before the transaction; its challenge is compared
//! again under lock so stale proofs cannot verify a replaced challenge.
use crate::{
    Database, StoreError, authority::current_actor, database::JournalTransaction,
    workspaces::lock_workspace,
};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use forge_core::{
    actor::{Actor, Authentication},
    security::{
        SecurityAction, SecurityFeature, SecuritySettings, WorkspacePlan, entitlements,
        normalized_domain,
    },
    security_commands::SecurityCommand,
    subscription::{SubscriptionState, subscription_access},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection};
use std::{collections::HashMap, time::Duration};
use uuid::Uuid;

#[async_trait]
pub trait TxtResolver: Send + Sync {
    /// Return each logical record with its character-string segments joined.
    async fn records(&self, domain: &str) -> Result<Vec<String>, StoreError>;
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedDomain {
    pub id: Uuid,
    pub domain: String,
    pub source: String,
    pub verified_at: Option<DateTime<Utc>>,
    pub verification_code: Option<String>,
    pub verification_expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Deserialize)]
struct SettingsRow {
    #[serde(flatten)]
    settings: SecuritySettings,
    version: i32,
    invite_link_version: i32,
    updated_at: DateTime<Utc>,
}

pub(crate) async fn settings(
    connection: &mut PgConnection,
    workspace: &str,
) -> Result<SecuritySettings, StoreError> {
    let value: Option<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(s) FROM workspace_security_settings s WHERE workspace_id=$1 FOR SHARE",
    )
    .bind(workspace)
    .fetch_optional(connection)
    .await?;
    value
        .map(|v| serde_json::from_value(v).map_err(|_| StoreError::InvalidInput))
        .unwrap_or_else(|| Ok(SecuritySettings::default()))
}

pub(crate) async fn authorize(
    connection: &mut PgConnection,
    actor: &Actor,
    action: SecurityAction,
) -> Result<Actor, StoreError> {
    let live = current_actor(connection, actor).await?;
    if !matches!(live.authentication, Authentication::Session { .. })
        || !settings(connection, &live.workspace_id)
            .await?
            .allows(&live, action)
    {
        return Err(StoreError::Forbidden);
    }
    Ok(live)
}

async fn settings_row(
    tx: &mut JournalTransaction,
    actor: &Actor,
) -> Result<SettingsRow, StoreError> {
    // INSERT of settings is itself included in the recovery journal.
    tx.prepare().await?;
    sqlx::query(
        "INSERT INTO workspace_security_settings(workspace_id) VALUES($1) ON CONFLICT DO NOTHING",
    )
    .bind(&actor.workspace_id)
    .execute(&mut **tx)
    .await?;
    let value: Value = sqlx::query_scalar(
        "SELECT to_jsonb(s) FROM workspace_security_settings s WHERE workspace_id=$1 FOR UPDATE",
    )
    .bind(&actor.workspace_id)
    .fetch_one(&mut **tx)
    .await?;
    serde_json::from_value(value).map_err(|_| StoreError::InvalidInput)
}

pub(crate) async fn api_key_policy(
    tx: &mut JournalTransaction,
    actor: &Actor,
) -> Result<Value, StoreError> {
    let row = settings_row(tx, actor).await?;
    Ok(
        json!({"version":row.version,"policy":row.settings.api_key_creation_policy,"canCreate":row.settings.api_key_creation_policy.allows(actor),"canManage":actor.has_role(&["owner","admin"])}),
    )
}

async fn plan(
    connection: &mut PgConnection,
    workspace: &str,
) -> Result<(WorkspacePlan, HashMap<SecurityFeature, bool>), StoreError> {
    let row: Option<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(e) FROM workspace_entitlements e WHERE workspace_id=$1 FOR SHARE",
    )
    .bind(workspace)
    .fetch_optional(connection)
    .await?;
    let state = row
        .clone()
        .filter(valid_subscription_row)
        .and_then(|v| serde_json::from_value::<SubscriptionState>(v).ok());
    let access = subscription_access(state.as_ref(), Some(Utc::now()));
    let mut overrides = HashMap::new();
    if let Some(state) = &state
        && (state.source.as_deref() != Some("polar") || access.plan != WorkspacePlan::Free)
        && let Some(values) = row
            .as_ref()
            .and_then(|r| r["feature_overrides"].as_object())
    {
        for (key, value) in values {
            if let (Ok(feature), Some(enabled)) = (
                serde_json::from_value::<SecurityFeature>(Value::String(key.clone())),
                value.as_bool(),
            ) {
                overrides.insert(feature, enabled);
            }
        }
    }
    Ok((access.plan, entitlements(access.plan, &overrides)))
}

fn valid_subscription_row(value: &Value) -> bool {
    for key in ["trial_redemption_id", "paid_upgrade_order_id"] {
        if let Some(v) = value.get(key)
            && !v.is_null()
            && !v.as_str().is_some_and(|s| Uuid::parse_str(s).is_ok())
        {
            return false;
        }
    }
    if let Some(overrides) = value.get("feature_overrides")
        && !overrides
            .as_object()
            .is_some_and(|o| o.values().all(Value::is_boolean))
    {
        return false;
    }
    if let Some(periods) = value.get("refunded_periods") {
        let Some(periods) = periods.as_array() else {
            return false;
        };
        for p in periods {
            if !["orderId", "subscriptionId"]
                .iter()
                .all(|key| p[*key].as_str().is_some_and(|s| Uuid::parse_str(s).is_ok()))
                || !matches!(p["environment"].as_str(), Some("sandbox" | "production"))
            {
                return false;
            }
            if let Some(kind) = p.get("kind")
                && kind != "upgrade"
            {
                return false;
            }
            if let Some(id) = p.get("starterOrderId")
                && !id.is_null()
                && !id.as_str().is_some_and(|s| Uuid::parse_str(s).is_ok())
            {
                return false;
            }
        }
    }
    true
}

pub(crate) async fn audit(
    connection: &mut PgConnection,
    actor: &Actor,
    action: &str,
    target: Option<&str>,
    outcome: &str,
    before: Option<Value>,
    after: Option<Value>,
) -> Result<(), StoreError> {
    sqlx::query("INSERT INTO workspace_security_audit_events(workspace_id,actor_user_id,action,target,outcome,\"before\",\"after\") VALUES($1,$2,$3,$4,$5,$6,$7)")
        .bind(&actor.workspace_id).bind(&actor.user_id).bind(action).bind(target).bind(outcome).bind(before).bind(after).execute(connection).await?;
    Ok(())
}

async fn snapshot_tx(
    tx: &mut JournalTransaction,
    actor: &Actor,
    row: SettingsRow,
    origin: &str,
    secret: &str,
) -> Result<Value, StoreError> {
    let workspace: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object('id',id,'name',name,'slug',slug) FROM organization WHERE id=$1",
    )
    .bind(&actor.workspace_id)
    .fetch_one(&mut **tx)
    .await?;
    let (plan, entitlements) = plan(tx, &actor.workspace_id).await?;
    let domains = sqlx::query_as::<_, ApprovedDomain>(
        "SELECT * FROM workspace_approved_domains WHERE workspace_id=$1 ORDER BY created_at,id",
    )
    .bind(&actor.workspace_id)
    .fetch_all(&mut **tx)
    .await?;
    let link = if row.settings.invite_links_enabled {
        let token = forge_identity::invite::InviteClaims {
            generation: row.invite_link_version,
            workspace_id: actor.workspace_id.clone(),
        }
        .sign(secret)
        .map_err(|_| StoreError::InvalidInput)?;
        Some(format!("{}/join/{token}", origin.trim_end_matches('/')))
    } else {
        None
    };
    Ok(
        json!({"workspace":workspace,"version":row.version,"canManage":true,"plan":plan,"entitlements":entitlements,"settings":row.settings,"inviteLink":link,"domains":domains,"updatedAt":row.updated_at}),
    )
}

pub async fn snapshot(
    database: &Database,
    actor: &Actor,
    origin: &str,
    secret: &str,
) -> Result<Value, StoreError> {
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, true).await?;
    let live = authorize(&mut tx, actor, SecurityAction::SecurityManage).await?;
    let row = settings_row(&mut tx, &live).await?;
    let result = snapshot_tx(&mut tx, &live, row, origin, secret).await?;
    tx.commit().await?;
    Ok(result)
}

fn command_target(command: &SecurityCommand) -> Option<String> {
    match command {
        SecurityCommand::SetBoolean { key, .. } => Some(key.key().into()),
        SecurityCommand::SetPolicy { key, .. } => Some(key.key().into()),
        SecurityCommand::AddDomain { domain, .. } => Some(domain.clone()),
        SecurityCommand::RemoveDomain { domain_id, .. }
        | SecurityCommand::VerifyDomain { domain_id, .. } => Some(domain_id.to_string()),
        _ => None,
    }
}

pub async fn execute(
    database: &Database,
    actor: &Actor,
    command: &SecurityCommand,
    resolver: &dyn TxtResolver,
    origin: &str,
    secret: &str,
) -> Result<Value, StoreError> {
    // Authenticate before any attacker-selected DNS lookup.
    let proof = if let SecurityCommand::VerifyDomain { domain_id, .. } = command {
        let mut preflight = database.begin().await?;
        lock_workspace(&mut preflight, &actor.workspace_id, false).await?;
        authorize(&mut preflight, actor, SecurityAction::SecurityManage).await?;
        preflight.commit().await?;
        let row = sqlx::query_as::<_, ApprovedDomain>(
            "SELECT * FROM workspace_approved_domains WHERE id=$1 AND workspace_id=$2",
        )
        .bind(domain_id)
        .bind(&actor.workspace_id)
        .fetch_optional(database.pool())
        .await?;
        if let Some(row) = row {
            if row.verified_at.is_none()
                && row
                    .verification_expires_at
                    .is_some_and(|at| at > Utc::now())
            {
                let records =
                    tokio::time::timeout(Duration::from_secs(5), resolver.records(&row.domain))
                        .await
                        .ok()
                        .and_then(Result::ok)
                        .unwrap_or_default();
                row.verification_code.filter(|code| records.contains(code))
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, true).await?;
    let live = current_actor(&mut tx, actor).await?;
    let kind = serde_json::to_value(command).map_err(|_| StoreError::InvalidInput)?["type"]
        .as_str()
        .ok_or(StoreError::InvalidInput)?
        .to_owned();
    let target = command_target(command);
    if !matches!(live.authentication, Authentication::Session { .. })
        || !live.has_role(&["owner", "admin"])
    {
        audit(
            &mut tx,
            &live,
            &format!("security.{kind}.rejected"),
            target.as_deref(),
            "rejected",
            None,
            None,
        )
        .await?;
        tx.commit().await?;
        return Err(StoreError::Forbidden);
    }
    let row = settings_row(&mut tx, &live).await?;
    sqlx::query("SAVEPOINT security_mutation")
        .execute(&mut *tx)
        .await?;
    let result = mutate(&mut tx, &live, &row, command, proof.as_deref()).await;
    if let Err(error) = result {
        sqlx::query("ROLLBACK TO SAVEPOINT security_mutation")
            .execute(&mut *tx)
            .await?;
        audit(
            &mut tx,
            &live,
            &format!("security.{kind}.rejected"),
            target.as_deref(),
            "rejected",
            None,
            None,
        )
        .await?;
        tx.commit().await?;
        return Err(error);
    }
    let row = settings_row(&mut tx, &live).await?;
    let value = snapshot_tx(&mut tx, &live, row, origin, secret).await?;
    tx.commit().await?;
    Ok(value)
}

async fn mutate(
    tx: &mut JournalTransaction,
    actor: &Actor,
    row: &SettingsRow,
    command: &SecurityCommand,
    proof: Option<&str>,
) -> Result<(), StoreError> {
    if command.expected_version() <= 0 {
        return Err(StoreError::InvalidInput);
    }
    if row.version != command.expected_version() {
        return Err(StoreError::Conflict);
    }
    if let Some(feature) = command.required_feature() {
        let (_, features) = plan(tx, &actor.workspace_id).await?;
        if !features[&feature] {
            return Err(StoreError::PlanRequired(feature.required_plan()));
        }
    }
    let (action, target, before, after) = match command {
        SecurityCommand::SetBoolean { key, value, .. } => {
            sqlx::query(&format!(
                "UPDATE workspace_security_settings SET {}=$1 WHERE workspace_id=$2",
                key.column()
            ))
            .bind(value)
            .bind(&actor.workspace_id)
            .execute(&mut **tx)
            .await?;
            (
                "security.setting.updated",
                Some(key.key().to_owned()),
                Some(json!({"value":key.get(&row.settings)})),
                Some(json!({"value":value})),
            )
        }
        SecurityCommand::SetPolicy { key, value, .. } => {
            let value = serde_json::to_value(value).map_err(|_| StoreError::InvalidInput)?;
            sqlx::query(&format!(
                "UPDATE workspace_security_settings SET {}=$1 WHERE workspace_id=$2",
                key.column()
            ))
            .bind(value.as_str())
            .bind(&actor.workspace_id)
            .execute(&mut **tx)
            .await?;
            (
                "security.setting.updated",
                Some(key.key().to_owned()),
                Some(json!({"value":key.get(&row.settings)})),
                Some(json!({"value":value})),
            )
        }
        SecurityCommand::ResetInviteLink { .. } => {
            sqlx::query("UPDATE workspace_security_settings SET invite_link_version=invite_link_version+1 WHERE workspace_id=$1").bind(&actor.workspace_id).execute(&mut **tx).await?;
            (
                "security.invite-link.reset",
                None,
                Some(json!({"generation":row.invite_link_version})),
                Some(json!({"generation":row.invite_link_version+1})),
            )
        }
        SecurityCommand::AddDomain { domain, .. } => {
            if forge_core::text::length(forge_core::text::trim(domain)) > 253 {
                return Err(StoreError::InvalidInput);
            }
            let domain = normalized_domain(domain).ok_or(StoreError::InvalidInput)?;
            let code = format!(
                "forge-domain-verification={}",
                forge_identity::random_token(24)
            );
            sqlx::query("INSERT INTO workspace_approved_domains(workspace_id,domain,verification_code,verification_expires_at,added_by_user_id) VALUES($1,$2,$3,clock_timestamp()+interval '24 hours',$4)")
                .bind(&actor.workspace_id).bind(&domain).bind(code).bind(&actor.user_id).execute(&mut **tx).await.map_err(domain_error)?;
            (
                "security.approved-domain.added",
                Some(domain),
                None,
                Some(json!({"source":"manual","verified":false})),
            )
        }
        SecurityCommand::RemoveDomain { domain_id, .. } => {
            let deleted = sqlx::query(
                "DELETE FROM workspace_approved_domains WHERE id=$1 AND workspace_id=$2",
            )
            .bind(domain_id)
            .bind(&actor.workspace_id)
            .execute(&mut **tx)
            .await?;
            if deleted.rows_affected() != 1 {
                return Err(StoreError::NotFound);
            }
            (
                "security.approved-domain.removed",
                Some(domain_id.to_string()),
                None,
                None,
            )
        }
        SecurityCommand::VerifyDomain { domain_id, .. } => {
            let code = proof.ok_or(StoreError::DomainUnverified)?;
            let updated=sqlx::query("UPDATE workspace_approved_domains SET verified_at=clock_timestamp(),verification_code=NULL,verification_expires_at=NULL WHERE id=$1 AND workspace_id=$2 AND verified_at IS NULL AND verification_code=$3 AND verification_expires_at>clock_timestamp()")
                .bind(domain_id).bind(&actor.workspace_id).bind(code).execute(&mut **tx).await.map_err(domain_error)?;
            if updated.rows_affected() != 1 {
                return Err(StoreError::DomainUnverified);
            }
            (
                "security.approved-domain.verified",
                Some(domain_id.to_string()),
                Some(json!({"verified":false})),
                Some(json!({"verified":true})),
            )
        }
    };
    sqlx::query("UPDATE workspace_security_settings SET version=version+1,updated_at=clock_timestamp(),updated_by_user_id=$1 WHERE workspace_id=$2").bind(&actor.user_id).bind(&actor.workspace_id).execute(&mut **tx).await?;
    audit(
        tx,
        actor,
        action,
        target.as_deref(),
        "succeeded",
        before,
        after,
    )
    .await?;
    Ok(())
}

fn domain_error(error: sqlx::Error) -> StoreError {
    if error
        .as_database_error()
        .is_some_and(|e| e.is_unique_violation())
    {
        StoreError::DomainTaken
    } else {
        error.into()
    }
}
