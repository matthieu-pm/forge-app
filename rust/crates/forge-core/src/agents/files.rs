//! Byte decoding and configuration shared by the agent attachment/artifact paths.
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub max_attachment_bytes: u64,
    pub max_turn_bytes: u64,
    pub attachment_retention_hours: u64,
    pub max_artifact_bytes: u64,
    pub artifact_retention_days: u64,
}
impl Default for Settings {
    fn default() -> Self {
        Self::from_environment(&HashMap::new())
    }
}
impl Settings {
    pub fn from_environment(env: &HashMap<String, String>) -> Self {
        let positive = |key, fallback| {
            super::policy::positive(env.get(key))
                .map(|v| v as u64)
                .unwrap_or(fallback)
        };
        Self {
            max_attachment_bytes: positive("FORGE_AGENT_MAX_ATTACHMENT_BYTES", 5 * 1024 * 1024),
            max_turn_bytes: positive("FORGE_AGENT_MAX_TURN_ATTACHMENT_BYTES", 20 * 1024 * 1024),
            attachment_retention_hours: positive("FORGE_AGENT_ATTACHMENT_RETENTION_HOURS", 24),
            max_artifact_bytes: positive("FORGE_AGENT_MAX_ARTIFACT_BYTES", 5 * 1024 * 1024),
            artifact_retention_days: super::policy::positive(
                env.get("FORGE_AGENT_ARTIFACT_RETENTION_DAYS"),
            )
            .filter(|v| *v <= 3650.)
            .unwrap_or(30.) as u64,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Code {
    AttachmentNotFound,
    AttachmentTooLarge,
    InvalidAttachment,
    ArtifactNotFound,
    ArtifactTooLarge,
    InvalidArtifactContent,
}
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct Error {
    pub code: Code,
    pub message: String,
}
impl Error {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Node Buffer's base64 decoding accepts URL-safe letters, ignores other bytes,
/// stops at the first padding marker and discards incomplete trailing bits.
pub fn decode_artifact(value: &str, base64: bool) -> Vec<u8> {
    if !base64 {
        return value.as_bytes().to_vec();
    }
    let mut output = Vec::new();
    let mut bits = 0u32;
    let mut count = 0;
    for byte in value.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(value);
        count += 6;
        if count >= 8 {
            count -= 8;
            output.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    output
}
pub fn decode_attachment(value: &str) -> Result<Vec<u8>, Error> {
    let bytes = decode_artifact(value, true);
    if bytes.is_empty()
        || STANDARD.encode(&bytes).trim_end_matches('=') != value.trim_end_matches('=')
    {
        return Err(Error::new(
            Code::InvalidAttachment,
            "The attachment content is not valid base64.",
        ));
    }
    Ok(bytes)
}
#[async_trait]
pub trait Blobs: Send + Sync {
    async fn put(&self, reference: &str, bytes: Vec<u8>) -> Result<(), crate::files::UploadError>;
    async fn get(
        &self,
        reference: &str,
        max_bytes: usize,
    ) -> Result<Option<Vec<u8>>, crate::files::UploadError>;
    async fn delete(&self, reference: &str) -> Result<(), crate::files::UploadError>;
}
