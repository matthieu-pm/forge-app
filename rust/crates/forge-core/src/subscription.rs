//! Read-time subscription access. Expiry, refunds and termination never depend
//! on a webhook or scheduled sweep having run first.

use crate::security::WorkspacePlan;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundPeriod {
    pub order_id: String,
    pub subscription_id: String,
    pub environment: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub refunded_at: DateTime<Utc>,
    pub kind: Option<String>,
    pub starter_order_id: Option<String>,
    pub base_period_start: Option<DateTime<Utc>>,
    pub base_period_end: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionState {
    pub plan: String,
    pub status: String,
    pub source: Option<String>,
    #[serde(alias = "source_reference")]
    pub source_reference: Option<String>,
    #[serde(alias = "trial_redemption_id")]
    pub trial_redemption_id: Option<String>,
    #[serde(alias = "provider_environment")]
    pub provider_environment: Option<String>,
    #[serde(alias = "refunded_periods", default)]
    pub refunded_periods: Vec<RefundPeriod>,
    #[serde(alias = "terminated_at")]
    pub terminated_at: Option<DateTime<Utc>>,
    #[serde(alias = "unsupported_pause_at")]
    pub unsupported_pause_at: Option<DateTime<Utc>>,
    #[serde(alias = "paid_upgrade_order_id")]
    pub paid_upgrade_order_id: Option<String>,
    #[serde(alias = "paid_activated_at")]
    pub paid_activated_at: Option<DateTime<Utc>>,
    #[serde(alias = "payment_failed_at")]
    pub payment_failed_at: Option<DateTime<Utc>>,
    #[serde(alias = "grace_expires_at")]
    pub grace_expires_at: Option<DateTime<Utc>>,
    #[serde(alias = "current_period_start")]
    pub current_period_start: Option<DateTime<Utc>>,
    #[serde(alias = "current_period_end")]
    pub current_period_end: Option<DateTime<Utc>>,
    #[serde(alias = "cancel_at_period_end", default)]
    pub cancel_at_period_end: bool,
    #[serde(alias = "cancellation_period_end")]
    pub cancellation_period_end: Option<DateTime<Utc>>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccessPhase {
    #[default]
    Free,
    Paid,
    Trial,
    Grace,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionAccess {
    pub plan: WorkspacePlan,
    pub phase: AccessPhase,
    pub allows_existing_overage: bool,
}

impl SubscriptionState {
    /// Match JavaScript's invalid-date behavior without permitting malformed
    /// required fields to grant access. Invalid optional dates are unavailable;
    /// an explicitly invalid pause cutoff denies access.
    pub fn from_json(mut value: serde_json::Value) -> Option<Self> {
        let object = value.as_object_mut()?;
        let mut invalid_pause = false;
        for key in [
            "terminatedAt",
            "terminated_at",
            "unsupportedPauseAt",
            "unsupported_pause_at",
            "paidActivatedAt",
            "paid_activated_at",
            "paymentFailedAt",
            "payment_failed_at",
            "graceExpiresAt",
            "grace_expires_at",
            "currentPeriodStart",
            "current_period_start",
            "currentPeriodEnd",
            "current_period_end",
            "cancellationPeriodEnd",
            "cancellation_period_end",
        ] {
            if let Some(date) = object.get_mut(key)
                && !date.is_null()
                && serde_json::from_value::<DateTime<Utc>>(date.clone()).is_err()
            {
                if matches!(
                    key,
                    "terminatedAt"
                        | "terminated_at"
                        | "unsupportedPauseAt"
                        | "unsupported_pause_at"
                ) {
                    invalid_pause = true;
                }
                *date = serde_json::Value::Null;
            }
        }
        let mut state: Self = serde_json::from_value(value).ok()?;
        if invalid_pause {
            state.terminated_at = Some(DateTime::UNIX_EPOCH);
        }
        Some(state)
    }
    fn refund_matches(&self, period: &RefundPeriod) -> bool {
        Some(period.subscription_id.as_str()) == self.source_reference.as_deref()
            && Some(period.environment.as_str()) == self.provider_environment.as_deref()
            && self
                .current_period_start
                .zip(self.current_period_end)
                .is_some_and(|(start, end)| {
                    period.start.timestamp_millis() < end.timestamp_millis()
                        && period.end.timestamp_millis() > start.timestamp_millis()
                })
    }
    pub fn is_refunded(&self) -> bool {
        self.source.as_deref() == Some("polar")
            && self.refunded_periods.iter().any(|period| {
                period.kind.as_deref() != Some("upgrade") && self.refund_matches(period)
            })
    }
}

pub fn subscription_access(
    state: Option<&SubscriptionState>,
    now: Option<DateTime<Utc>>,
) -> SubscriptionAccess {
    let free = SubscriptionAccess::default();
    let Some(state) = state else { return free };
    let Some(now) = now else { return free };
    let at = now.timestamp_millis();
    if state.terminated_at.is_some()
        || state
            .unsupported_pause_at
            .is_some_and(|cutoff| at >= cutoff.timestamp_millis())
    {
        return free;
    }
    let plan = WorkspacePlan::from_storage(&state.plan);
    if plan == WorkspacePlan::Free {
        return free;
    }
    if state.source.as_deref() == Some("forge-trial") {
        let Some((start, end)) = state.current_period_start.zip(state.current_period_end) else {
            return free;
        };
        let start = start.timestamp_millis();
        let end = end.timestamp_millis();
        if state.status != "trialing"
            || state
                .trial_redemption_id
                .as_ref()
                .is_none_or(String::is_empty)
            || state.source_reference != state.trial_redemption_id
            || state.provider_environment.is_some()
            || state.paid_activated_at.is_some()
            || state.cancel_at_period_end
            || end - start != 14 * 86_400_000
            || at < start
            || at >= end
        {
            return free;
        }
        return SubscriptionAccess {
            plan,
            phase: AccessPhase::Trial,
            allows_existing_overage: false,
        };
    }
    if state.is_refunded()
        || (state.cancel_at_period_end
            && state
                .cancellation_period_end
                .is_none_or(|end| at >= end.timestamp_millis()))
    {
        return free;
    }
    if state.source.as_deref() == Some("polar") {
        let refunds: Vec<_> = state
            .refunded_periods
            .iter()
            .filter(|period| {
                period.kind.as_deref() == Some("upgrade")
                    && state.refund_matches(period)
                    && state
                        .paid_upgrade_order_id
                        .as_ref()
                        .is_none_or(|id| id.is_empty() || id == &period.order_id)
            })
            .collect();
        if !refunds.is_empty() {
            let paid_base = refunds.iter().any(|period| {
                period
                    .starter_order_id
                    .as_ref()
                    .is_some_and(|id| !id.is_empty())
                    && period
                        .base_period_start
                        .zip(period.base_period_end)
                        .is_some_and(|(start, end)| {
                            at >= start.timestamp_millis() && at < end.timestamp_millis()
                        })
            });
            return if paid_base {
                SubscriptionAccess {
                    plan: WorkspacePlan::Basic,
                    phase: AccessPhase::Paid,
                    allows_existing_overage: true,
                }
            } else {
                free
            };
        }
    }
    let scheduled_cancellation = state.source.as_deref() == Some("polar")
        && state.status == "canceled"
        && state.cancel_at_period_end;
    if state.status == "active" || state.status == "trialing" || scheduled_cancellation {
        if state.source.as_deref() == Some("polar") {
            let Some((start, end)) = state.current_period_start.zip(state.current_period_end)
            else {
                return free;
            };
            let start = start.timestamp_millis();
            let end = end.timestamp_millis();
            if (state.status != "active" && !scheduled_cancellation)
                || start >= end
                || at < start
                || at >= end
                || state
                    .paid_activated_at
                    .is_none_or(|paid| paid.timestamp_millis() > at)
            {
                return free;
            }
        }
        return if state.status == "trialing" {
            SubscriptionAccess {
                plan,
                phase: AccessPhase::Trial,
                allows_existing_overage: false,
            }
        } else {
            SubscriptionAccess {
                plan,
                phase: AccessPhase::Paid,
                allows_existing_overage: true,
            }
        };
    }
    if state.status != "past_due" || state.source.as_deref() != Some("polar") {
        return free;
    }
    let Some((activated, failed, expires)) = state
        .paid_activated_at
        .zip(state.payment_failed_at)
        .zip(state.grace_expires_at)
        .map(|((a, f), e)| {
            (
                a.timestamp_millis(),
                f.timestamp_millis(),
                e.timestamp_millis(),
            )
        })
    else {
        return free;
    };
    if activated >= failed
        || failed.checked_add(7 * 86_400_000) != Some(expires)
        || at < failed
        || at >= expires
    {
        return free;
    }
    SubscriptionAccess {
        plan,
        phase: AccessPhase::Grace,
        allows_existing_overage: true,
    }
}
