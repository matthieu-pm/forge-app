//! Durable job identities and operator recovery contracts, shared with the
//! existing job ledger. Errors deliberately carry no provider/database payload.
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Code {
    #[error("JOB_FAILED")]
    JobFailed,
    #[error("LEASE_LOST")]
    LeaseLost,
    #[error("IDENTITY_CONFLICT")]
    IdentityConflict,
    #[error("RECOVERY_CONFLICT")]
    RecoveryConflict,
    #[error("RECONCILIATION_REQUIRED")]
    ReconciliationRequired,
    #[error("INVALID_INPUT")]
    InvalidInput,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{code}")]
pub struct Error {
    pub code: Code,
    pub permanent: bool,
}
impl From<Code> for Error {
    fn from(code: Code) -> Self {
        Self {
            code,
            permanent: false,
        }
    }
}
impl Error {
    pub fn permanent(code: Code) -> Self {
        Self {
            code,
            permanent: true,
        }
    }
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Queued,
    Running,
    Retry,
    Completed,
    Dead,
    Reconcile,
}

pub fn key(value: &str) -> bool {
    static RE: std::sync::LazyLock<regress::Regex> =
        std::sync::LazyLock::new(|| regress::Regex::new(r"^[a-zA-Z0-9:._-]{1,200}$").unwrap());
    RE.find(value).is_some()
}
pub fn uuid(value: &str) -> Result<Uuid> {
    static RE: std::sync::LazyLock<regress::Regex> = std::sync::LazyLock::new(|| {
        regress::Regex::with_flags(
            r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            "i",
        )
        .unwrap()
    });
    let matched = RE.find(value).ok_or(Code::InvalidInput)?;
    Uuid::parse_str(&value[matched.range()]).map_err(|_| Code::InvalidInput.into())
}
pub fn json(value: &Value) -> Result<String> {
    let body = crate::canonical::command_input(value);
    if body.len() > 16384 {
        return Err(Code::InvalidInput.into());
    }
    Ok(body)
}
pub fn date(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[derive(Clone, Debug)]
pub struct Enqueue {
    pub kind: String,
    pub scope: String,
    pub identity: String,
    pub input: Value,
    pub scheduled_at: DateTime<Utc>,
    pub max_attempts: i32,
}
impl Enqueue {
    pub fn validate(&self) -> Result<(String, String)> {
        if ![&self.kind, &self.scope, &self.identity]
            .into_iter()
            .all(|s| key(s))
            || !(1..=20).contains(&self.max_attempts)
        {
            return Err(Code::InvalidInput.into());
        }
        let body = json(&self.input)?;
        let hash = crate::canonical::command_input_hash(
            &serde_json::json!({"input":self.input,"scheduledAt":date(self.scheduled_at),"maxAttempts":self.max_attempts}),
        );
        Ok((body, hash))
    }
}
#[derive(Clone, Debug)]
pub struct Lease {
    pub id: Uuid,
    pub token: Uuid,
    pub generation: i32,
    pub attempt: i32,
    pub kind: String,
    pub input: Value,
    pub queue_age_ms: f64,
}
#[derive(Clone, Copy, Debug)]
pub enum ExternalPolicy {
    ProviderIdempotent { valid_until: DateTime<Utc> },
    Reconcile,
}
impl ExternalPolicy {
    pub fn mode(self) -> &'static str {
        match self {
            Self::ProviderIdempotent { .. } => "provider-idempotent",
            Self::Reconcile => "reconcile",
        }
    }
}
#[derive(Clone, Debug)]
pub struct Recovery {
    raw: Value,
    pub request_id: Uuid,
    pub job_id: Uuid,
    pub operator_id: Uuid,
    pub generation: i64,
    pub reason: String,
    pub action: RecoveryAction,
}
#[derive(Clone, Debug)]
pub enum RecoveryAction {
    Replay,
    Resolve {
        step: String,
        completed: bool,
        evidence: String,
    },
}
impl Recovery {
    pub fn parse(raw: Value) -> Result<Self> {
        let string = |k: &str| raw.get(k).and_then(Value::as_str).ok_or(Code::InvalidInput);
        let request_id = uuid(string("requestId")?)?;
        let job_id = uuid(string("jobId")?)?;
        let operator_id = uuid(string("operatorId")?)?;
        let generation = raw
            .get("generation")
            .and_then(Value::as_f64)
            .filter(|n| *n >= 0. && n.fract() == 0. && *n <= i64::MAX as f64)
            .ok_or(Code::InvalidInput)? as i64;
        let reason = string("reason")?.to_owned();
        if !["dependency-restored", "code-fixed", "provider-confirmed"].contains(&reason.as_str()) {
            return Err(Code::InvalidInput.into());
        }
        let action = match string("action")? {
            "replay" => RecoveryAction::Replay,
            "resolve" => {
                let step = string("step")?.to_owned();
                let evidence = string("evidence")?.to_owned();
                if raw.get("quiesced") != Some(&Value::Bool(true))
                    || !key(&step)
                    || !key(&evidence)
                    || reason != "provider-confirmed"
                {
                    return Err(Code::InvalidInput.into());
                }
                let completed = match string("outcome")? {
                    "completed" => true,
                    "retry-safe" => false,
                    _ => return Err(Code::InvalidInput.into()),
                };
                RecoveryAction::Resolve {
                    step,
                    completed,
                    evidence,
                }
            }
            _ => return Err(Code::InvalidInput.into()),
        };
        Ok(Self {
            raw,
            request_id,
            job_id,
            operator_id,
            generation,
            reason,
            action,
        })
    }
    pub fn fingerprint(&self) -> String {
        crate::canonical::command_input_hash(&self.raw)
    }
}
