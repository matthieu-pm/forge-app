//! Receipt hashes must remain identical across JavaScript and Rust, including
//! JavaScript's UTF-16 key ordering and ECMAScript number formatting.

use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn command_input(value: &Value) -> String {
    serialize(value, true)
}

/// JSON.stringify semantics for independently signed records, including object
/// insertion order and JavaScript's special ordering of array-index keys.
pub fn javascript_stringify(value: &Value) -> String {
    serialize(value, false)
}

fn serialize(value: &Value, sort_keys: bool) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).expect("JSON string"),
        Value::Number(number) => {
            // Inputs crossed the existing JavaScript JSON seam as doubles.
            let number = number.as_f64().expect("finite JSON number");
            ryu_js::Buffer::new().format(number).to_owned()
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(|item| serialize(item, sort_keys))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(object) => {
            let mut entries: Vec<_> = object.iter().collect();
            if sort_keys {
                entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            } else {
                let index = |key: &str| {
                    key.parse::<u32>()
                        .ok()
                        .filter(|index| *index != u32::MAX && index.to_string() == key)
                };
                entries.sort_by(|(a, _), (b, _)| match (index(a), index(b)) {
                    (Some(a), Some(b)) => a.cmp(&b),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => std::cmp::Ordering::Equal,
                });
            }
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON key"),
                        serialize(value, sort_keys)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

pub fn command_input_hash(value: &Value) -> String {
    hex::encode(Sha256::digest(command_input(value).as_bytes()))
}
