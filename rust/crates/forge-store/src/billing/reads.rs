//! Composed billing reads share the access policy used by enforcement. They do
//! not expose provider records or infer missing replacement payment authority.
use super::*;
use forge_core::subscription::{AccessPhase, SubscriptionState, subscription_access};

const ACCESS_DATES: &[&str] = &[
    "terminatedAt",
    "unsupportedPauseAt",
    "paidActivatedAt",
    "paymentFailedAt",
    "graceExpiresAt",
    "currentPeriodStart",
    "currentPeriodEnd",
    "cancellationPeriodEnd",
];

fn uuid(value: &Value) -> bool {
    value.as_str().is_some_and(forge_core::text::is_uuid)
}

/// readSubscriptionAccessState's failed safeParse discards the entire row.
/// Validate before from_json, whose general access-policy boundary deliberately
/// tolerates some invalid dates. Ignored provider metadata is not a date input.
fn access_state(raw: Option<Value>) -> Value {
    let Some(raw) = raw else { return Value::Null };
    if !crate::security::valid_subscription_row(&raw)
        || raw.get("source").is_some_and(|source| !source.is_string())
        || ["trial_redemption_id", "paid_upgrade_order_id"]
            .iter()
            .any(|key| raw.get(*key).is_some_and(|v| !v.is_null() && !uuid(v)))
    {
        return Value::Null;
    }
    if let Some(periods) = raw["refunded_periods"].as_array() {
        for period in periods {
            if !uuid(&period["orderId"])
                || !uuid(&period["subscriptionId"])
                || period
                    .get("starterOrderId")
                    .is_some_and(|v| !v.is_null() && !uuid(v))
            {
                return Value::Null;
            }
            for key in [
                "start",
                "end",
                "refundedAt",
                "basePeriodStart",
                "basePeriodEnd",
            ] {
                if matches!(key, "basePeriodStart" | "basePeriodEnd") && period.get(key).is_none() {
                    continue;
                }
                if policy::provider::instant(&period[key]).is_err() {
                    return Value::Null;
                }
            }
        }
    }
    let mut state = camel_columns(raw);
    if super::projection::normalize_dates(&mut state, ACCESS_DATES).is_err()
        || SubscriptionState::from_json(state.clone()).is_none()
    {
        return Value::Null;
    }
    state
}

fn replacement_context(row: Value) -> Result<Value, StoreError> {
    let bad = || fail("INVALID_BILLING_INPUT");
    if !uuid(&row["id"])
        || row["workspaceId"].as_str().is_none_or(str::is_empty)
        || !matches!(row["environment"].as_str(), Some("sandbox" | "production"))
        || !uuid(&row["subscriptionId"])
        || !matches!(row["targetCurrency"].as_str(), Some("eur" | "usd"))
        || !matches!(row["renewalPlan"].as_str(), Some("starter" | "plus"))
    {
        return Err(bad());
    }
    let members = policy::safe_integer(&row["renewalMembers"], 1).map_err(|_| bad())?;
    let price = policy::safe_integer(&row["renewalPriceMinor"], 1).map_err(|_| bad())?;
    let anchor = policy::safe_integer(&row["billingAnchorDay"], 1).map_err(|_| bad())?;
    if anchor > 31 {
        return Err(bad());
    }
    let normalized = |key: &str| date(&row[key]).map(stamp).map_err(|_| bad());
    // Legacy rows with no original anchor cannot establish a replacement
    // anniversary. Relative calendar and provider proof checks belong to the
    // verifier; this mirrors the owning context schema and strips row extras.
    Ok(json!({
        "requestId":row["id"],
        "workspaceId":row["workspaceId"],
        "environment":row["environment"],
        "sourceSubscriptionId":row["subscriptionId"],
        "targetCurrency":row["targetCurrency"],
        "renewalPlan":row["renewalPlan"],
        "renewalMembers":members,
        "renewalPriceMinor":price,
        "originalPeriodStart":normalized("originalPeriodStart")?,
        "effectiveAt":normalized("effectiveAt")?,
        "anchorDay":anchor,
        "nextRenewalAt":normalized("nextRenewalAt")?,
        "checkoutGraceEndsAt":normalized("checkoutGraceEndsAt")?
    }))
}

impl Service {
    pub async fn billing_summary(&self, actor: &Actor) -> Result<Value, StoreError> {
        self.billing_summary_with_clock(actor, now).await
    }

    /// The same read path with a deterministic access-decision instant.
    pub async fn billing_summary_at(
        &self,
        actor: &Actor,
        at: DateTime<Utc>,
    ) -> Result<Value, StoreError> {
        self.billing_summary_with_clock(actor, || at).await
    }

    async fn billing_summary_with_clock(
        &self,
        actor: &Actor,
        clock: impl FnOnce() -> DateTime<Utc>,
    ) -> Result<Value, StoreError> {
        if !matches!(actor.authentication, Authentication::Session { .. }) {
            return Err(StoreError::Forbidden);
        }
        let mut tx = self.database.begin().await?;
        let actor = current_actor(&mut tx, actor).await?;
        let raw = sqlx::query_scalar(
            "SELECT to_jsonb(e) FROM workspace_entitlements e WHERE workspace_id=$1",
        )
        .bind(&actor.workspace_id)
        .fetch_optional(&mut *tx)
        .await?;
        // Every accepted membership counts, regardless of its role. Billing's
        // admin-only management identity is not a summary-read prerequisite.
        let active_members: i64 =
            sqlx::query_scalar("SELECT count(*) FROM member WHERE organization_id=$1")
                .bind(&actor.workspace_id)
                .fetch_one(&mut *tx)
                .await?;
        let at = clock();
        let state = access_state(raw);
        let parsed = SubscriptionState::from_json(state.clone());
        let access = subscription_access(parsed.as_ref(), Some(at));
        let notices = policy::usage::notices(
            &json!({"state":state,"activeMembers":active_members,"now":stamp(at)}),
        )?;
        let trial_expires_at = if access.phase == AccessPhase::Trial {
            state["currentPeriodEnd"].clone()
        } else {
            Value::Null
        };
        let result = json!({
            "plan":access.plan,
            "phase":access.phase,
            "activeMembers":active_members,
            "notices":notices,
            "trialExpiresAt":trial_expires_at
        });
        tx.commit().await?;
        Ok(result)
    }

    pub async fn replacement_anniversary_context(
        &self,
        actor: &Actor,
        request_id: &str,
        environment: &str,
    ) -> Result<Value, StoreError> {
        // Source ordering rechecks the current admin and subscription binding
        // before parsing the request key or looking up its row.
        let binding = self.cancellation_context(actor, environment).await?;
        if !forge_core::text::is_uuid(request_id) {
            return Err(fail("INVALID_BILLING_INPUT"));
        }
        let key = request_id
            .parse::<Uuid>()
            .map_err(|_| fail("INVALID_BILLING_INPUT"))?;
        let row: Option<Value> = sqlx::query_scalar(
            "SELECT to_jsonb(r) FROM workspace_currency_change_requests r WHERE id=$1",
        )
        .bind(key)
        .fetch_optional(self.database.pool())
        .await?;
        let row = row.map(camel_columns).unwrap_or(Value::Null);
        if row.is_null()
            || row["workspaceId"] != binding["workspaceId"]
            || row["environment"] != environment
            || row["subscriptionId"] != binding["subscriptionId"]
            || row["state"] != "requested"
        {
            return Err(fail("BILLING_REPLACEMENT_CONTEXT_CHANGED"));
        }
        replacement_context(row)
    }
}
