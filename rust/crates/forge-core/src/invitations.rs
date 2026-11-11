//! Invitation lifecycle decisions shared by the HTTP host and durable worker.
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Effect {
    #[serde(rename = "initial")]
    Initial,
    #[serde(rename = "reminder-24h")]
    Reminder,
}
impl Effect {
    pub fn key(self, invitation: &str) -> String {
        let effect = match self {
            Self::Initial => "initial",
            Self::Reminder => "reminder-24h",
        };
        format!("workspace-invitation:{invitation}:{effect}:v1")
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Decision {
    Deliver,
    NotPending,
    Expired,
    TooCloseToExpiry,
}
pub fn classify(
    effect: Effect,
    status: &str,
    expires_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Decision {
    if status != "pending" {
        Decision::NotPending
    } else if expires_at <= now {
        Decision::Expired
    } else if effect == Effect::Reminder && expires_at - now < Duration::minutes(15) {
        Decision::TooCloseToExpiry
    } else {
        Decision::Deliver
    }
}

pub fn enabled(flag: &str, allowlist: &str, workspace: &str) -> bool {
    flag == "true"
        && !workspace.is_empty()
        && allowlist
            .split(',')
            .map(crate::text::trim)
            .any(|id| id == workspace)
}
pub fn can_start(sdk_run_id: Option<&str>, state: &str) -> bool {
    sdk_run_id.is_none() && matches!(state, "queued" | "starting" | "failed-to-start")
}

/// No provider response, recipient or exception text crosses the error boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("Email delivery failed.")]
pub struct DeliveryError {
    pub retryable: bool,
    pub status_code: Option<u16>,
}
impl DeliveryError {
    pub fn provider(status_code: Option<u16>, name: &str) -> Self {
        Self {
            retryable: status_code.is_none_or(|s| matches!(s, 408 | 425 | 429) || s >= 500)
                || matches!(
                    name,
                    "application_error"
                        | "internal_server_error"
                        | "concurrent_idempotent_requests"
                ),
            status_code,
        }
    }
    pub fn invalid() -> Self {
        Self {
            retryable: false,
            status_code: None,
        }
    }
    pub fn retry_after(self) -> Option<Duration> {
        self.retryable
            .then(|| Duration::seconds(if self.status_code == Some(429) { 60 } else { 5 }))
    }
}
