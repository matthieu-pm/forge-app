use super::*;
use policy::projection::{Command, Context, Event, Kind};

impl Service {
    /// Internal verified-provider sink. No HTTP route accepts these observations.
    pub async fn apply_subscription_snapshot(&self, input: Value) -> Result<Value, StoreError> {
        self.apply_verified_billing_event(Event::parse(Kind::Snapshot, &input)?)
            .await
    }
    /// Internal verified-provider refund sink; event payloads alone are not proof.
    pub async fn apply_period_refund(&self, input: Value) -> Result<Value, StoreError> {
        self.apply_verified_billing_event(Event::parse(Kind::Refund, &input)?)
            .await
    }
    async fn apply_verified_billing_event(&self, event: Event) -> Result<Value, StoreError> {
        let mut tx = self.database.begin().await?;
        sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
            .bind(&event.workspace)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| fail("BILLING_WORKSPACE_NOT_FOUND"))?;
        // Preserve the owning command's authority contract: a first-party billing
        // identity and current owner/admin membership. Provider webhooks have no actor.
        let member_role = if let Some(actor) = &event.actor {
            sqlx::query_scalar(
                "SELECT role FROM member WHERE organization_id=$1 AND user_id=$2 FOR SHARE",
            )
            .bind(&event.workspace)
            .bind(&actor.user_id)
            .fetch_optional(&mut *tx)
            .await?
        } else {
            None
        };
        let receipt=sqlx::query_scalar("SELECT jsonb_build_object('workspaceId',workspace_id,'environment',environment,'eventId',event_id,'bodyHash',body_hash,'subscriptionId',subscription_id,'outcome',outcome) FROM billing_event_receipts WHERE environment=$1 AND event_id=$2")
            .bind(&event.environment).bind(&event.event_id).fetch_optional(&mut *tx).await?.unwrap_or(Value::Null);
        let previous = normalized_state(&mut tx, &event.workspace).await?;
        let plan = event.plan(&Context {
            previous,
            receipt,
            member_role,
            workspace_exists: true,
            now: now(),
        })?;
        if !plan.commands.is_empty() {
            tx.prepare().await?;
        }
        execute_commands(
            &mut tx,
            &event.workspace,
            &event.environment,
            &event.event_id,
            plan.commands,
        )
        .await?;
        tx.commit().await?;
        Ok(plan.answer)
    }
}
pub(super) async fn normalized_state(
    c: &mut PgConnection,
    workspace: &str,
) -> Result<Value, StoreError> {
    let mut value = state(c, workspace).await?;
    normalize_dates(
        &mut value,
        &[
            "providerUpdatedAt",
            "updatedAt",
            "terminatedAt",
            "unsupportedPauseAt",
            "paidActivatedAt",
            "paymentFailedAt",
            "graceExpiresAt",
            "currentPeriodStart",
            "currentPeriodEnd",
            "cancellationPeriodEnd",
        ],
    )?;
    Ok(value)
}
pub(super) fn normalize_dates(value: &mut Value, keys: &[&str]) -> Result<(), StoreError> {
    if let Some(object) = value.as_object_mut() {
        for key in keys {
            if let Some(value) = object.get_mut(*key)
                && !value.is_null()
            {
                *value = json!(stamp(date(value)?));
            }
        }
    }
    Ok(())
}
pub(super) async fn execute_commands(
    c: &mut PgConnection,
    workspace: &str,
    environment: &str,
    event_id: &str,
    commands: Vec<Command>,
) -> Result<(), StoreError> {
    for command in commands {
        match command {
            Command::EntitlementInsert { values } => {
                insert(c, "workspace_entitlements", values, None).await?
            }
            Command::EntitlementUpsert { values, set } => {
                insert(c, "workspace_entitlements", values, Some(set)).await?
            }
            Command::EntitlementUpdate { set } => {
                let (columns, value) = record(set)?;
                let sql = format!(
                    "UPDATE workspace_entitlements SET ({columns})=(SELECT {columns} FROM jsonb_populate_record(NULL::workspace_entitlements,$1)) WHERE workspace_id=$2"
                );
                sqlx::query(&sql)
                    .bind(value)
                    .bind(workspace)
                    .execute(&mut *c)
                    .await?;
            }
            Command::AuditInsert { values } => {
                insert(c, "workspace_security_audit_events", values, None).await?
            }
            Command::ReceiptInsert { values } => {
                insert(c, "billing_event_receipts", values, None).await?
            }
            Command::ReceiptUpdate { set } => {
                sqlx::query("UPDATE billing_event_receipts SET outcome=$3 WHERE environment=$1 AND event_id=$2").bind(environment).bind(event_id).bind(text(&set["outcome"])?).execute(&mut *c).await?;
            }
            Command::CurrencyInsert { values } => {
                insert(c, "workspace_currency_change_requests", values, None).await?
            }
            Command::CurrencyUpdate { id: key, set } => {
                let (columns, value) = record(set)?;
                let sql = format!(
                    "UPDATE workspace_currency_change_requests SET ({columns})=(SELECT {columns} FROM jsonb_populate_record(NULL::workspace_currency_change_requests,$1)) WHERE id=$2 AND workspace_id=$3"
                );
                sqlx::query(&sql)
                    .bind(value)
                    .bind(id(&key)?)
                    .bind(workspace)
                    .execute(&mut *c)
                    .await?;
            }
        }
    }
    Ok(())
}
// Only the closed policy command set can reach this mapper. Every identifier is
// a literal; input values are always bound. Omitted columns retain database defaults.
fn column(key: &str) -> Result<&'static str, StoreError> {
    Ok(match key {
        "id" => "id",
        "state" => "state",
        "billingCountry" => "billing_country",
        "fromCurrency" => "from_currency",
        "targetCurrency" => "target_currency",
        "currentPlan" => "current_plan",
        "renewalPlan" => "renewal_plan",
        "renewalMembers" => "renewal_members",
        "renewalPriceMinor" => "renewal_price_minor",
        "effectiveAt" => "effective_at",
        "originalPeriodStart" => "original_period_start",
        "billingAnchorDay" => "billing_anchor_day",
        "nextRenewalAt" => "next_renewal_at",
        "checkoutGraceEndsAt" => "checkout_grace_ends_at",
        "workspaceId" => "workspace_id",
        "plan" => "plan",
        "status" => "status",
        "source" => "source",
        "sourceReference" => "source_reference",
        "providerEnvironment" => "provider_environment",
        "providerUpdatedAt" => "provider_updated_at",
        "providerStateHash" => "provider_state_hash",
        "currentPeriodStart" => "current_period_start",
        "currentPeriodEnd" => "current_period_end",
        "terminatedAt" => "terminated_at",
        "unsupportedPauseAt" => "unsupported_pause_at",
        "cancelAtPeriodEnd" => "cancel_at_period_end",
        "cancellationPeriodEnd" => "cancellation_period_end",
        "paidActivatedAt" => "paid_activated_at",
        "paymentFailedAt" => "payment_failed_at",
        "graceExpiresAt" => "grace_expires_at",
        "updatedAt" => "updated_at",
        "paidUpgradeOrderId" => "paid_upgrade_order_id",
        "refundedPeriods" => "refunded_periods",
        "actorUserId" => "actor_user_id",
        "action" => "action",
        "target" => "target",
        "outcome" => "outcome",
        "after" => "after",
        "requestId" => "request_id",
        "environment" => "environment",
        "eventId" => "event_id",
        "bodyHash" => "body_hash",
        "subscriptionId" => "subscription_id",
        _ => return Err(invalid()),
    })
}
fn record(value: Value) -> Result<(String, Value), StoreError> {
    let object = value.as_object().ok_or_else(invalid)?;
    if object.is_empty() {
        return Err(invalid());
    }
    let mut columns = vec![];
    let mut result = serde_json::Map::new();
    for (key, value) in object {
        let name = column(key)?;
        columns.push(format!("\"{name}\""));
        result.insert(name.into(), value.clone());
    }
    Ok((columns.join(","), Value::Object(result)))
}
async fn insert(
    c: &mut PgConnection,
    table: &'static str,
    values: Value,
    set: Option<Value>,
) -> Result<(), StoreError> {
    let (columns, values) = record(values)?;
    let mut sql = format!(
        "INSERT INTO {table}({columns}) SELECT {columns} FROM jsonb_populate_record(NULL::{table},$1)"
    );
    let set = if let Some(set) = set {
        let (columns, set) = record(set)?;
        sql.push_str(&format!(" ON CONFLICT(workspace_id) DO UPDATE SET ({columns})=(SELECT {columns} FROM jsonb_populate_record(NULL::{table},$2))"));
        Some(set)
    } else {
        None
    };
    let query = sqlx::query(&sql).bind(values);
    if let Some(set) = set {
        query.bind(set).execute(c).await?;
    } else {
        query.execute(c).await?;
    }
    Ok(())
}
