use super::calendar::{date, period, stamp};
use super::*;
use crate::subscription::{AccessPhase, SubscriptionState, subscription_access};
use chrono::{DateTime, Utc};
fn time(state: &Value, key: &str) -> Result<DateTime<Utc>> {
    date(&state[key]).map_err(|_| Error("USAGE_PERIOD_RECONCILIATION_REQUIRED"))
}
pub fn paid_binding(state: &Value) -> Result<String> {
    if state["source"] != "polar"
        || state["sourceReference"].as_str().is_none_or(str::is_empty)
        || !["sandbox", "production"]
            .iter()
            .any(|s| state["providerEnvironment"] == *s)
    {
        return Err(Error("USAGE_PAID_BINDING_REQUIRED"));
    }
    Ok(serde_json::to_string(&json!([
        "polar",
        state["providerEnvironment"],
        state["sourceReference"]
    ]))
    .unwrap())
}
pub fn authority(value: &Value) -> Result<Value> {
    let state = &value["state"];
    let now = date(&value["now"])?;
    let created = date(&value["workspaceCreatedAt"])?;
    let workspace = string(&value["workspaceId"])?;
    if now < created {
        return Err(Error("USAGE_BEFORE_WORKSPACE"));
    }
    if !state["currentPeriodStart"].is_null() && time(state, "currentPeriodStart")? < created {
        return Err(Error("USAGE_PERIOD_BEFORE_WORKSPACE"));
    }
    let parsed = SubscriptionState::from_json(state.clone());
    let access = subscription_access(parsed.as_ref(), Some(now));
    let plan = match access.plan {
        crate::security::WorkspacePlan::Free => "free",
        crate::security::WorkspacePlan::Basic => "starter",
        crate::security::WorkspacePlan::Business => "plus",
        crate::security::WorkspacePlan::Enterprise => {
            return Err(Error("USAGE_ENTERPRISE_AGREEMENT_REQUIRED"));
        }
    };
    let phase = if access.phase == AccessPhase::Trial {
        "trial"
    } else {
        "standard"
    };
    if access.phase == AccessPhase::Trial {
        if state["source"] != "forge-trial"
            || state["trialRedemptionId"]
                .as_str()
                .is_none_or(str::is_empty)
        {
            return Err(Error("USAGE_BOUND_TRIAL_REQUIRED"));
        }
        return Ok(
            json!({"kind":"trial","plan":plan,"phase":phase,"binding":state["trialRedemptionId"],"period":period(workspace,now,&json!({"kind":"trial","trialStartedAt":stamp(time(state,"currentPeriodStart")?)}))?,"transition":null,"grace":false}),
        );
    }
    if [AccessPhase::Paid, AccessPhase::Grace].contains(&access.phase) {
        let binding = paid_binding(state)?;
        let start = time(state, "currentPeriodStart")?;
        let end = time(state, "currentPeriodEnd")?;
        let grace = access.phase == AccessPhase::Grace;
        let period = if grace {
            Value::Null
        } else {
            period(
                workspace,
                now,
                &json!({"kind":"paid-monthly","currentPeriodStart":stamp(start),"currentPeriodEnd":stamp(end)}),
            )?
        };
        return Ok(
            json!({"kind":"paid","plan":plan,"phase":phase,"binding":binding,"period":period,"transition":null,"grace":grace}),
        );
    }
    let period = period(
        workspace,
        now,
        &json!({"kind":"free","workspaceCreatedAt":stamp(created)}),
    )?;
    let mut transition = Value::Null;
    if state["source"] == "forge-trial" {
        let end = time(state, "currentPeriodEnd")?;
        let start = time(state, "currentPeriodStart")?;
        if state["trialRedemptionId"]
            .as_str()
            .is_none_or(str::is_empty)
            || end > now
        {
            return Err(Error("USAGE_TRIAL_RECONCILIATION_REQUIRED"));
        }
        transition = json!({"kind":"trial-expiry","binding":state["trialRedemptionId"],"effectiveAt":stamp(end),"sourceStart":stamp(start),"sourceEnd":stamp(end),"failedAt":null});
    } else if state["source"] == "polar" && !state["paidActivatedAt"].is_null() {
        let start = time(state, "currentPeriodStart")?;
        let end = time(state, "currentPeriodEnd")?;
        let cutoff = if state["status"] == "past_due" && !state["graceExpiresAt"].is_null() {
            time(state, "graceExpiresAt")?
        } else {
            end
        };
        let mut candidates = vec![cutoff];
        for key in ["terminatedAt", "unsupportedPauseAt"] {
            if let Ok(at) = date(&state[key]) {
                candidates.push(at);
            }
        }
        if state["cancelAtPeriodEnd"] == true
            && let Ok(at) = date(&state["cancellationPeriodEnd"])
        {
            candidates.push(at);
        }
        candidates.retain(|at| *at <= now);
        if let Some(refunds) = state["refundedPeriods"].as_array() {
            for refund in refunds {
                if refund["kind"] != "upgrade"
                    && refund["subscriptionId"] == state["sourceReference"]
                    && refund["environment"] == state["providerEnvironment"]
                    && date(&refund["start"]).is_ok_and(|at| at < end)
                    && date(&refund["end"]).is_ok_and(|at| at > start)
                {
                    let at = time(refund, "refundedAt")?;
                    if at <= now {
                        candidates.push(at);
                    }
                }
            }
        }
        let effective = candidates
            .into_iter()
            .min()
            .ok_or(Error("USAGE_DOWNGRADE_RECONCILIATION_REQUIRED"))?;
        transition = json!({"kind":"paid-to-free","binding":paid_binding(state)?,"effectiveAt":stamp(effective),"sourceStart":stamp(start),"sourceEnd":stamp(end),"failedAt":date(&state["paymentFailedAt"]).ok().map(stamp)});
    } else if state["source"]
        .as_str()
        .is_some_and(|s| !s.is_empty() && !["internal", "polar"].contains(&s))
    {
        return Err(Error("USAGE_SOURCE_RECONCILIATION_REQUIRED"));
    }
    Ok(
        json!({"kind":"free","plan":"free","phase":phase,"binding":stamp(created),"period":period,"transition":transition,"grace":false}),
    )
}
pub fn notices(value: &Value) -> Result<Value> {
    let state = &value["state"];
    let parsed = SubscriptionState::from_json(state.clone());
    let access = subscription_access(parsed.as_ref(), date(&value["now"]).ok());
    let mut notices = vec![];
    let mut add = |code: &str, key: &str, field: Option<&str>| {
        notices.push(json!({"code":code,"message":POLICY["noticeMessages"][key],"effectiveAt":field.and_then(|key|date(&state[key]).ok()).map(stamp)}));
    };
    if access.phase == AccessPhase::Trial {
        add("trial", "trial", Some("currentPeriodEnd"));
    }
    if access.phase == AccessPhase::Grace {
        add("payment-grace", "payment-grace", Some("graceExpiresAt"));
    }
    if access.phase != AccessPhase::Free && state["cancelAtPeriodEnd"] == true {
        add(
            "cancellation",
            "cancellation",
            Some("cancellationPeriodEnd"),
        );
    }
    if access.phase != AccessPhase::Free && !state["unsupportedPauseAt"].is_null() {
        add(
            "provider-pause",
            "provider-pause",
            Some("unsupportedPauseAt"),
        );
    }
    if access.phase == AccessPhase::Free {
        add(
            "free-capacity",
            if value["activeMembers"].as_f64().unwrap_or(0.) >= 5. {
                "free-capacity-high"
            } else {
                "free-capacity-low"
            },
            None,
        );
    }
    Ok(json!(notices))
}
