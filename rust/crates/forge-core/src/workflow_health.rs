//! Business-workflow health, plus native queue ownership and wake-up checks.
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Effect {
    pub state: String,
    pub completed_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: Uuid,
    pub kind: String,
    pub scope: String,
    pub identity: String,
    pub state: String,
    pub available_at: DateTime<Utc>,
    pub lease_until: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: Uuid,
    pub workspace_id: String,
    pub kind: String,
    pub state: String,
    pub sdk_run_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub initial: Option<Effect>,
    pub reminder: Option<Effect>,
    pub job: Option<Job>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    #[serde(rename = "sdk_run_id_missing_5m")]
    SdkRunIdMissing,
    TerminalWorkflowFailure,
    #[serde(rename = "initial_effect_incomplete_15m")]
    InitialEffectIncomplete,
    #[serde(rename = "reminder_overdue_15m")]
    ReminderOverdue,
    NativeJobMissing,
    NativeJobFailed,
    #[serde(rename = "native_job_overdue_5m")]
    NativeJobOverdue,
    NativeLeaseExpired,
    NativeStateMismatch,
}
pub fn classify(run: &Run, now: DateTime<Utc>) -> Option<Code> {
    if run.sdk_run_id.is_none()
        && matches!(run.state.as_str(), "queued" | "starting")
        && run.created_at <= now - Duration::minutes(5)
    {
        return Some(Code::SdkRunIdMissing);
    }
    if matches!(
        run.state.as_str(),
        "failed-to-start" | "failed" | "cancelled"
    ) {
        return Some(Code::TerminalWorkflowFailure);
    }
    if run.kind == "workspace-invitation-lifecycle-v1" && run.state == "running" {
        if run
            .started_at
            .is_some_and(|at| at <= now - Duration::minutes(15))
            && !run
                .initial
                .as_ref()
                .is_some_and(|effect| effect.state == "completed")
        {
            return Some(Code::InitialEffectIncomplete);
        }
        if run
            .initial
            .as_ref()
            .and_then(|effect| effect.completed_at)
            .is_some_and(|at| at <= now - Duration::minutes(24 * 60 + 15))
            && !run
                .reminder
                .as_ref()
                .is_some_and(|effect| effect.state == "completed")
        {
            return Some(Code::ReminderOverdue);
        }
    }
    let owner = run.sdk_run_id.as_deref()?;
    if !owner.starts_with("forge-native-job:")
        || !matches!(run.state.as_str(), "queued" | "starting" | "running")
    {
        return None;
    }
    let Some(job) = run.job.as_ref().filter(|job| {
        owner == format!("forge-native-job:{}", job.id)
            && job.kind == run.kind
            && job.scope == run.workspace_id
            && job.identity == run.id.to_string()
    }) else {
        return Some(Code::NativeJobMissing);
    };
    match job.state.as_str() {
        "dead" | "reconcile" => Some(Code::NativeJobFailed),
        "running" if job.lease_until.is_none_or(|until| until <= now) => {
            Some(Code::NativeLeaseExpired)
        }
        "queued" | "retry" if job.available_at <= now - Duration::minutes(5) => {
            Some(Code::NativeJobOverdue)
        }
        "completed" => Some(Code::NativeStateMismatch),
        "queued" | "retry" | "running" => None,
        _ => Some(Code::NativeStateMismatch),
    }
}
