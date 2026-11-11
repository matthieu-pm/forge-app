//! Private file contracts. Storage references never confer resource authority.
pub use crate::contract::ContractError as FileContractError;
use crate::contract::{self as c, Object};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
pub mod delivery;
pub mod grants;
pub mod upload;
pub mod verification;
pub const MAX_BYTES: usize = 100_000_000;
pub const PREVIEW_MAX_BYTES: usize = 1_000_000;
pub const GRANT_SECONDS: i64 = 300;
pub const ACCOUNT_PENDING: i64 = 4;
pub const WORKSPACE_PENDING: i64 = 16;
pub const ACCOUNT_HOURLY_BYTES: i64 = 1_000_000_000;
pub const WORKSPACE_HOURLY_BYTES: i64 = 10_000_000_000;
pub const ATTEMPTS_PER_HOUR: usize = 5;
pub const LIFETIME_MS: i64 = 86_400_000;
pub const TOKEN_MS: i64 = 600_000;
fn pattern(v: Value, expression: &str) -> c::Result<Value> {
    let text = v.as_str().ok_or(FileContractError("text"))?;
    if regress::Regex::new(expression)
        .unwrap()
        .find(text)
        .is_none()
    {
        return Err(FileContractError("pattern"));
    }
    Ok(v)
}
pub fn upload_target(v: Value) -> c::Result<Value> {
    let agent = v["kind"] == "agent";
    let mut o = Object::new(v, if agent { &["kind"] } else { &["kind", "id"] }, true)?;
    o.required("kind", |v| {
        c::enumeration(
            v,
            if agent {
                &["agent"]
            } else {
                &["issue", "document", "project"]
            },
        )
    })?;
    if !agent {
        o.required("id", c::uuid)?;
    }
    Ok(o.finish())
}
pub fn resource_target(v: Value) -> c::Result<Value> {
    let mut o = Object::new(v, &["kind", "id"], true)?;
    o.required("kind", |v| {
        c::enumeration(v, &["issue", "document", "project"])
    })?;
    o.required("id", c::uuid)?;
    Ok(o.finish())
}
pub fn delivery_target(v: Value) -> c::Result<Value> {
    let mut o = Object::new(v, &["kind", "id"], true)?;
    o.required("kind", |v| {
        c::enumeration(v, &["resources", "artifacts", "attachments"])
    })?;
    o.required("id", c::uuid)?;
    Ok(o.finish())
}
pub fn upload_input(v: Value) -> c::Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "commandKey",
            "target",
            "name",
            "contentType",
            "sizeBytes",
            "checksum",
        ],
        true,
    )?;
    o.required("commandKey", c::uuid)?;
    o.required("target", upload_target)?;
    o.required("name", |v| {
        let v = c::text(v, 1, 200, true)?;
        if v.as_str()
            .unwrap()
            .chars()
            .any(|c| c == '/' || c == '\\' || c <= '\u{1f}' || c == '\u{7f}')
        {
            return Err(FileContractError("file name"));
        }
        Ok(v)
    })?;
    o.required("contentType", |v| {
        let s = v.as_str().ok_or(FileContractError("content type"))?;
        pattern(
            c::text(json!(crate::text::trim(s).to_lowercase()), 0, 120, false)?,
            r"^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$",
        )
    })?;
    o.required("sizeBytes", |v| c::number(v, 1., MAX_BYTES as f64, true))?;
    o.required("checksum", |v| pattern(v, r"^[a-f0-9]{64}$"))?;
    Ok(o.finish())
}
pub fn ready_upload(v: Value) -> c::Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "id",
            "name",
            "contentType",
            "sizeBytes",
            "checksum",
            "createdAt",
            "expiresAt",
        ],
        true,
    )?;
    o.required("id", c::uuid)?;
    o.required("name", c::string)?;
    o.required("contentType", c::string)?;
    o.required("sizeBytes", |v| c::number(v, 1., 9007199254740991., true))?;
    o.required("checksum", |v| pattern(v, r"^[a-f0-9]{64}$"))?;
    o.required("createdAt", c::datetime)?;
    o.required("expiresAt", |v| c::nullable(v, c::datetime))?;
    Ok(o.finish())
}
pub fn resource_input(v: Value) -> c::Result<Value> {
    let mut o = Object::new(v, &["name", "contentType"], false)?;
    o.required("name", |v| {
        let v = c::text(v, 1, 200, true)?;
        if v.as_str().unwrap().contains(['/', '\\', '\r', '\n', '\0']) {
            return Err(FileContractError("file name"));
        }
        Ok(v)
    })?;
    o.required("contentType", |v| {
        pattern(
            c::text(v, 1, 120, false)?,
            r"^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$",
        )
    })?;
    Ok(o.finish())
}
pub fn reference(value: &str) -> bool {
    static RE: std::sync::OnceLock<regress::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        let id = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
        regress::Regex::new(&format!("^(?:files/{id}|attachments/{id}|{id}/{id})$")).unwrap()
    })
    .find(value)
    .is_some()
}
pub fn checksum(content: &[u8]) -> String {
    hex::encode(Sha256::digest(content))
}
pub fn content_matches(content: &[u8], metadata: &Value) -> bool {
    metadata["sizeBytes"].as_u64() == Some(content.len() as u64)
        && metadata["checksum"] == checksum(content)
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum UploadError {
    #[error("Sign in to upload files.")]
    Unauthenticated,
    #[error("{0}")]
    Invalid(&'static str),
    #[error("{0}")]
    Access(&'static str),
    #[error("{message}")]
    Limit {
        message: &'static str,
        retry_after_seconds: Option<u64>,
    },
    #[error("{0}")]
    Conflict(&'static str),
    #[error("{0}")]
    Unavailable(&'static str),
    #[error("The upload could not be completed. Retry using the same upload intent.")]
    Transport,
}
impl UploadError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unauthenticated => "UNAUTHENTICATED",
            Self::Invalid(_) => "INVALID_UPLOAD",
            Self::Access(_) => "FORBIDDEN",
            Self::Limit { .. } => "UPLOAD_LIMIT",
            Self::Conflict(_) => "UPLOAD_CONFLICT",
            Self::Unavailable(_) | Self::Transport => "UPLOAD_UNAVAILABLE",
        }
    }
    pub fn permanent(&self) -> bool {
        matches!(self, Self::Invalid(_) | Self::Access(_))
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DeliveryError {
    #[error("The file is unavailable or you no longer have access.")]
    NotFound,
    #[error("The file link is invalid or expired. Request a new link.")]
    InvalidGrant,
    #[error("The file could not be read. Try again.")]
    Unavailable,
    #[error("A preview is unavailable for this file. Download it to view it.")]
    PreviewUnavailable,
    #[error("Sign in to access files.")]
    Unauthenticated,
}
impl DeliveryError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotFound => "FILE_NOT_FOUND",
            Self::InvalidGrant => "INVALID_FILE_GRANT",
            Self::Unavailable => "FILE_UNAVAILABLE",
            Self::PreviewUnavailable => "PREVIEW_UNAVAILABLE",
            Self::Unauthenticated => "UNAUTHENTICATED",
        }
    }
}
