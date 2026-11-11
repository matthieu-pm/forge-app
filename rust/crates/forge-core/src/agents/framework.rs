//! EVE's default sandbox tools have closed inputs and no implicit defaults at
//! the schema boundary. Defaults are applied by execution, as in the source SDK.
use crate::contract::*;
use serde_json::Value;
use std::sync::LazyLock;

static DESCRIPTORS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../data/framework-tools.json"))
        .expect("source framework tool definitions")
});
pub fn descriptors() -> &'static [Value] {
    &DESCRIPTORS
}
pub fn input(name: &str, value: Value) -> Result<Value> {
    let keys: &[&str] = match name {
        "bash" => &["command"],
        "read_file" => &["filePath", "limit", "offset"],
        "write_file" => &["filePath", "content"],
        "glob" => &["path", "pattern", "limit"],
        "grep" => &[
            "path",
            "pattern",
            "limit",
            "context",
            "glob",
            "ignoreCase",
            "literal",
        ],
        _ => return Err(ContractError("framework tool")),
    };
    let mut object = Object::new(value, keys, true)?;
    match name {
        "bash" => object.required("command", string)?,
        "read_file" | "write_file" => {
            object.required("filePath", string)?;
            if name == "read_file" {
                for key in ["limit", "offset"] {
                    object.optional(key, |v| number(v, 1., 9_007_199_254_740_991., true))?;
                }
            } else {
                object.required("content", string)?;
            }
        }
        _ => {
            object.required("pattern", string)?;
            object.optional("path", string)?;
            object.optional("limit", |v| number(v, 1., 1000., true))?;
            if name == "grep" {
                object.optional("glob", string)?;
                object.optional("context", integer)?;
                object.optional("ignoreCase", boolean)?;
                object.optional("literal", boolean)?;
            }
        }
    }
    Ok(object.finish())
}
