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
        let mut previous = state(&mut tx, &event.workspace).await?;
        // Drizzle exposes Date objects, serialized with milliseconds and Z. JSON
        // returned directly by PostgreSQL uses its own timestamp representation.
        if let Some(object) = previous.as_object_mut() {
            for key in [
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
            ] {
                if let Some(value) = object.get_mut(key)
                    && !value.is_null()
                {
                    *value = json!(stamp(date(value)?));
                }
            }
        }
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
        for command in plan.commands {
            match command {
                Command::EntitlementInsert { values } => {
                    insert(&mut tx, "workspace_entitlements", values, None).await?
                }
                Command::EntitlementUpsert { values, set } => {
                    insert(&mut tx, "workspace_entitlements", values, Some(set)).await?
                }
                Command::EntitlementUpdate { set } => {
                    let (columns, value) = record(set)?;
                    let sql = format!(
                        "UPDATE workspace_entitlements SET ({columns})=(SELECT {columns} FROM jsonb_populate_record(NULL::workspace_entitlements,$1)) WHERE workspace_id=$2"
                    );
                    sqlx::query(&sql)
                        .bind(value)
                        .bind(&event.workspace)
                        .execute(&mut *tx)
                        .await?;
                }
                Command::AuditInsert { values } => {
                    insert(&mut tx, "workspace_security_audit_events", values, None).await?
                }
                Command::ReceiptInsert { values } => {
                    insert(&mut tx, "billing_event_receipts", values, None).await?
                }
                Command::ReceiptUpdate { set } => {
                    sqlx::query("UPDATE billing_event_receipts SET outcome=$3 WHERE environment=$1 AND event_id=$2").bind(&event.environment).bind(&event.event_id).bind(text(&set["outcome"])?).execute(&mut *tx).await?;
                }
            }
        }
        tx.commit().await?;
        Ok(plan.answer)
    }
}
// Only the closed policy command set can reach this mapper. Every identifier is
// a literal; input values are always bound. Omitted columns retain database defaults.
fn column(key: &str) -> Result<&'static str, StoreError> {
    Ok(match key {
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
