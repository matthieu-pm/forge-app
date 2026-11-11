use super::*;
pub(super) struct Error(pub u16, pub String, pub String);
pub(super) fn failure(status: u16, code: &str, message: &str) -> Error {
    Error(status, code.into(), message.into())
}
pub(super) fn invalid() -> Error {
    failure(400, "INVALID_INPUT", "The request input is invalid.")
}
pub(super) fn unauthorized() -> Error {
    failure(401, "UNAUTHORIZED", "Sign in to use Forge agents.")
}
pub(super) fn unavailable() -> Error {
    failure(
        503,
        "RUNTIME_UNAVAILABLE",
        "Forge Agent is not configured for this deployment.",
    )
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        json_response(json!({"error":{"code":self.1,"message":self.2}}), self.0)
    }
}
impl From<StoreError> for Error {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::InvalidInput => invalid(),
            StoreError::Unauthenticated => unauthorized(),
            StoreError::EmailNotVerified => failure(
                403,
                "EMAIL_VERIFICATION_REQUIRED",
                "Verify your email address before using Forge.",
            ),
            StoreError::Forbidden | StoreError::NoActiveWorkspace => failure(
                403,
                "FORBIDDEN",
                "You do not have permission to perform this action.",
            ),
            StoreError::Conflict => failure(
                409,
                "CONFLICT",
                "The agent operation conflicts with the current state.",
            ),
            StoreError::AgentCoordinator { code, message } => failure(
                match code {
                    "THREAD_NOT_FOUND" | "RUN_NOT_FOUND" => 404,
                    "THREAD_ARCHIVED" => 409,
                    "BUDGET_EXCEEDED" => 402,
                    _ => 503,
                },
                code,
                message,
            ),
            StoreError::AgentRouting(e) => failure(
                if e.code == "AUTO_UNAVAILABLE" {
                    409
                } else {
                    400
                },
                e.code,
                &e.message,
            ),
            StoreError::Approval(e) => Self(
                match e.code {
                    forge_core::agents::approval::Code::ApprovalNotFound => 404,
                    forge_core::agents::approval::Code::ApprovalBindingMismatch => 403,
                    _ => 409,
                },
                json!(e.code).as_str().unwrap().into(),
                e.message.into(),
            ),
            StoreError::ModelConnection(e) => Self(
                match e.code {
                    forge_core::agents::providers::Code::ConnectionNotFound => 404,
                    forge_core::agents::providers::Code::PolicyBlocked => 403,
                    forge_core::agents::providers::Code::VaultUnavailable => 503,
                    _ => 400,
                },
                json!(e.code).as_str().unwrap().into(),
                e.message.into(),
            ),
            StoreError::AgentFile(e) => Self(
                if matches!(
                    e.code,
                    forge_core::agents::files::Code::ArtifactNotFound
                        | forge_core::agents::files::Code::AttachmentNotFound
                ) {
                    404
                } else {
                    400
                },
                json!(e.code).as_str().unwrap().into(),
                e.message,
            ),
            _ => failure(
                500,
                "INTERNAL_ERROR",
                "The agent request could not be completed.",
            ),
        }
    }
}
