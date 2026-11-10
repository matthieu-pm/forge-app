//! Receipt hashes must remain identical across JavaScript and Rust, including
//! JavaScript's UTF-16 key ordering and ECMAScript number formatting.

use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn command_input(value: &Value) -> String {
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
                .map(command_input)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(object) => {
            let mut entries: Vec<_> = object.iter().collect();
            entries.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON key"),
                        command_input(value)
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
