use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

macro_rules! text_enum {
    ($name:ident { $($variant:ident),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, sqlx::Type)]
        #[serde(rename_all = "kebab-case")]
        #[sqlx(type_name = "text", rename_all = "kebab-case")]
        pub enum $name { $($variant),+ }
    }
}
text_enum!(ThreadStatus { Active, Archived });
text_enum!(Runtime { Eve, Codex, Claude });
text_enum!(RunState {
    Created,
    Connecting,
    Running,
    WaitingForApproval,
    Reconnecting,
    Cancelled,
    Failed,
    Completed
});
text_enum!(Execution {
    ForgeNative,
    ExternalAgent
});
text_enum!(Effort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max
});
text_enum!(ApprovalState {
    Pending,
    Approved,
    Denied,
    Expired,
    Consumed
});
text_enum!(Risk {
    Read,
    ReversibleWrite,
    ImportantWrite,
    Destructive
});
text_enum!(InvocationState {
    InProgress,
    Completed
});
text_enum!(Outcome { Succeeded, Failed });
text_enum!(SelectionMode { Auto, Manual });

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: Uuid,
    pub workspace_id: String,
    pub created_by_user_id: String,
    pub title: String,
    pub status: ThreadStatus,
    pub runtime_kind: Runtime,
    pub runtime_session_id: Option<String>,
    #[serde(with = "time")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "time")]
    pub updated_at: DateTime<Utc>,
    #[serde(with = "time")]
    pub last_activity_at: DateTime<Utc>,
    pub last_run_state: Option<RunState>,
}
#[derive(Clone, Debug)]
pub struct CreateThread {
    pub id: Uuid,
    pub workspace_id: String,
    pub created_by_user_id: String,
    pub title: String,
    pub status: ThreadStatus,
    pub runtime_kind: Runtime,
    pub runtime_session_id: Option<String>,
    pub created_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Default)]
pub struct ThreadPatch {
    pub title: Option<String>,
    pub status: Option<ThreadStatus>,
    pub runtime_kind: Option<Runtime>,
    pub runtime_session_id: Option<Option<String>>,
    pub last_activity_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: Uuid,
    pub thread_id: Uuid,
    pub initiated_by_user_id: String,
    pub state: RunState,
    pub execution_kind: Execution,
    pub requested_selection: Value,
    pub resolved_connection_id: Option<Uuid>,
    pub resolved_model_id: Option<String>,
    pub reasoning_effort: Option<Effort>,
    pub routing_policy_version: Option<String>,
    pub routing_reason: Option<String>,
    pub runtime_run_id: Option<String>,
    pub input_tokens: i32,
    pub output_tokens: i32,
    pub cached_input_tokens: i32,
    pub cost_micros: i32,
    #[serde(with = "optional_time")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(with = "optional_time")]
    pub completed_at: Option<DateTime<Utc>>,
    pub error_code: Option<String>,
    #[serde(with = "time")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "time")]
    pub updated_at: DateTime<Utc>,
}
#[derive(Clone, Debug)]
pub struct CreateRun {
    pub id: Uuid,
    pub thread_id: Uuid,
    pub initiated_by_user_id: String,
    pub state: RunState,
    pub execution_kind: Execution,
    pub requested_selection: Value,
    pub resolved_connection_id: Option<Uuid>,
    pub resolved_model_id: Option<String>,
    pub reasoning_effort: Option<Effort>,
    pub routing_policy_version: Option<String>,
    pub routing_reason: Option<String>,
    pub runtime_run_id: Option<String>,
    pub input_tokens: i32,
    pub output_tokens: i32,
    pub cached_input_tokens: i32,
    pub cost_micros: i32,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub error_code: Option<String>,
}
#[derive(Clone, Debug, Default)]
pub struct RunPatch {
    pub state: Option<RunState>,
    pub runtime_run_id: Option<Option<String>>,
    pub input_tokens: Option<i32>,
    pub output_tokens: Option<i32>,
    pub cached_input_tokens: Option<i32>,
    pub cost_micros: Option<i32>,
    pub started_at: Option<Option<DateTime<Utc>>>,
    pub completed_at: Option<Option<DateTime<Utc>>>,
    pub error_code: Option<Option<String>>,
}
#[derive(Debug, PartialEq, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub cost_micros: i64,
    pub active_runs: i32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: Uuid,
    pub source_event_id: String,
    pub thread_id: Uuid,
    pub run_id: Uuid,
    pub sequence: i32,
    #[serde(with = "time")]
    pub occurred_at: DateTime<Utc>,
    pub source: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub schema_version: i32,
    pub payload: Value,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: Uuid,
    pub workspace_id: String,
    pub run_id: Uuid,
    pub requested_for_user_id: String,
    pub capability_id: String,
    pub capability_version: String,
    pub risk: Risk,
    pub input_hash: String,
    pub redacted_input_summary: Value,
    pub state: ApprovalState,
    pub nonce: String,
    #[serde(with = "time")]
    pub requested_at: DateTime<Utc>,
    #[serde(with = "time")]
    pub expires_at: DateTime<Utc>,
    #[serde(with = "optional_time")]
    pub resolved_at: Option<DateTime<Utc>>,
    pub resolved_by_user_id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invocation {
    pub id: Uuid,
    pub workspace_id: String,
    pub user_id: String,
    pub run_id: Uuid,
    pub approval_id: Uuid,
    pub capability_id: String,
    pub capability_version: String,
    pub idempotency_key: String,
    pub input_hash: String,
    pub state: InvocationState,
    pub outcome: Option<Outcome>,
    pub duration_ms: Option<i32>,
    /// JSON null represents a reservation without a result.
    pub result: Value,
    #[serde(with = "time")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "time")]
    pub expires_at: DateTime<Utc>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Preference {
    pub thread_id: Uuid,
    pub mode: SelectionMode,
    pub selected_connection_id: Option<Uuid>,
    pub selected_model_id: Option<String>,
    pub selected_effort: Option<Effort>,
    #[serde(with = "time")]
    pub updated_at: DateTime<Utc>,
}
mod time {
    use super::*;
    pub fn serialize<S: serde::Serializer>(v: &DateTime<Utc>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(d: D) -> Result<DateTime<Utc>, D::Error> {
        DateTime::deserialize(d)
    }
}
mod optional_time {
    use super::*;
    pub fn serialize<S: serde::Serializer>(
        v: &Option<DateTime<Utc>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        v.map(|v| v.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .serialize(s)
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        d: D,
    ) -> Result<Option<DateTime<Utc>>, D::Error> {
        Option::<DateTime<Utc>>::deserialize(d)
    }
}

impl sqlx::FromRow<'_, sqlx::postgres::PgRow> for Run {
    fn from_row(row: &sqlx::postgres::PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: sqlx::Row::try_get(row, "id")?,
            thread_id: sqlx::Row::try_get(row, "thread_id")?,
            initiated_by_user_id: sqlx::Row::try_get(row, "initiated_by_user_id")?,
            state: sqlx::Row::try_get(row, "state")?,
            execution_kind: sqlx::Row::try_get(row, "execution_kind")?,
            requested_selection: read_json(row, "requested_selection")?,
            resolved_connection_id: sqlx::Row::try_get(row, "resolved_connection_id")?,
            resolved_model_id: sqlx::Row::try_get(row, "resolved_model_id")?,
            reasoning_effort: sqlx::Row::try_get(row, "reasoning_effort")?,
            routing_policy_version: sqlx::Row::try_get(row, "routing_policy_version")?,
            routing_reason: sqlx::Row::try_get(row, "routing_reason")?,
            runtime_run_id: sqlx::Row::try_get(row, "runtime_run_id")?,
            input_tokens: sqlx::Row::try_get(row, "input_tokens")?,
            output_tokens: sqlx::Row::try_get(row, "output_tokens")?,
            cached_input_tokens: sqlx::Row::try_get(row, "cached_input_tokens")?,
            cost_micros: sqlx::Row::try_get(row, "cost_micros")?,
            started_at: sqlx::Row::try_get(row, "started_at")?,
            completed_at: sqlx::Row::try_get(row, "completed_at")?,
            error_code: sqlx::Row::try_get(row, "error_code")?,
            created_at: sqlx::Row::try_get(row, "created_at")?,
            updated_at: sqlx::Row::try_get(row, "updated_at")?,
        })
    }
}

impl sqlx::FromRow<'_, sqlx::postgres::PgRow> for Event {
    fn from_row(row: &sqlx::postgres::PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: sqlx::Row::try_get(row, "id")?,
            source_event_id: sqlx::Row::try_get(row, "source_event_id")?,
            thread_id: sqlx::Row::try_get(row, "thread_id")?,
            run_id: sqlx::Row::try_get(row, "run_id")?,
            sequence: sqlx::Row::try_get(row, "sequence")?,
            occurred_at: sqlx::Row::try_get(row, "occurred_at")?,
            source: sqlx::Row::try_get(row, "source")?,
            kind: sqlx::Row::try_get(row, "type")?,
            schema_version: sqlx::Row::try_get(row, "schema_version")?,
            payload: read_json(row, "payload")?,
        })
    }
}

impl sqlx::FromRow<'_, sqlx::postgres::PgRow> for Approval {
    fn from_row(row: &sqlx::postgres::PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: sqlx::Row::try_get(row, "id")?,
            workspace_id: sqlx::Row::try_get(row, "workspace_id")?,
            run_id: sqlx::Row::try_get(row, "run_id")?,
            requested_for_user_id: sqlx::Row::try_get(row, "requested_for_user_id")?,
            capability_id: sqlx::Row::try_get(row, "capability_id")?,
            capability_version: sqlx::Row::try_get(row, "capability_version")?,
            risk: sqlx::Row::try_get(row, "risk")?,
            input_hash: sqlx::Row::try_get(row, "input_hash")?,
            redacted_input_summary: read_json(row, "redacted_input_summary")?,
            state: sqlx::Row::try_get(row, "state")?,
            nonce: sqlx::Row::try_get(row, "nonce")?,
            requested_at: sqlx::Row::try_get(row, "requested_at")?,
            expires_at: sqlx::Row::try_get(row, "expires_at")?,
            resolved_at: sqlx::Row::try_get(row, "resolved_at")?,
            resolved_by_user_id: sqlx::Row::try_get(row, "resolved_by_user_id")?,
        })
    }
}

impl sqlx::FromRow<'_, sqlx::postgres::PgRow> for Invocation {
    fn from_row(row: &sqlx::postgres::PgRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: sqlx::Row::try_get(row, "id")?,
            workspace_id: sqlx::Row::try_get(row, "workspace_id")?,
            user_id: sqlx::Row::try_get(row, "user_id")?,
            run_id: sqlx::Row::try_get(row, "run_id")?,
            approval_id: sqlx::Row::try_get(row, "approval_id")?,
            capability_id: sqlx::Row::try_get(row, "capability_id")?,
            capability_version: sqlx::Row::try_get(row, "capability_version")?,
            idempotency_key: sqlx::Row::try_get(row, "idempotency_key")?,
            input_hash: sqlx::Row::try_get(row, "input_hash")?,
            state: sqlx::Row::try_get(row, "state")?,
            outcome: sqlx::Row::try_get(row, "outcome")?,
            duration_ms: sqlx::Row::try_get(row, "duration_ms")?,
            result: read_json(row, "result")?,
            created_at: sqlx::Row::try_get(row, "created_at")?,
            expires_at: sqlx::Row::try_get(row, "expires_at")?,
        })
    }
}

fn read_json(row: &sqlx::postgres::PgRow, column: &str) -> Result<Value, sqlx::Error> {
    let text: String = sqlx::Row::try_get(row, column)?;
    forge_core::json::parse(&text).map_err(|error| sqlx::Error::ColumnDecode {
        index: column.into(),
        source: Box::new(error),
    })
}
