use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Approval fingerprints use localeCompare ordering, unlike command receipts'
/// UTF-16 ordering. JSON.stringify then reorders array-index object keys.
pub fn input_hash(input: &Value) -> String {
    fn ordered(value: &Value, compare: &impl Fn(&str, &str) -> std::cmp::Ordering) -> Value {
        match value {
            Value::Array(values) => {
                Value::Array(values.iter().map(|v| ordered(v, compare)).collect())
            }
            Value::Object(object) => {
                let mut entries: Vec<_> = object.iter().collect();
                entries.sort_by(|(a, _), (b, _)| compare(a, b));
                Value::Object(
                    entries
                        .into_iter()
                        .map(|(key, value)| (key.clone(), ordered(value, compare)))
                        .collect(),
                )
            }
            _ => value.clone(),
        }
    }
    let collator = icu_collator::Collator::try_new(Default::default(), Default::default()).unwrap();
    hex::encode(Sha256::digest(
        crate::canonical::javascript_stringify(&ordered(input, &|a, b| collator.compare(a, b)))
            .as_bytes(),
    ))
}

pub fn program_grant_allows(
    approval_capability: &str,
    summary: &Value,
    capability: &str,
    version: &str,
) -> bool {
    approval_capability == "program.execute"
        && summary["details"]["programManifest"]
            .as_array()
            .is_some_and(|manifest| {
                manifest
                    .iter()
                    .any(|entry| entry["id"] == capability && entry["version"] == version)
            })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Code {
    ApprovalNotFound,
    ApprovalBindingMismatch,
    ApprovalExpired,
    ApprovalNotPending,
    ApprovalNotApproved,
}
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct Error {
    pub code: Code,
    pub message: &'static str,
}
impl Error {
    pub fn new(code: Code, message: &'static str) -> Self {
        Self { code, message }
    }
}
