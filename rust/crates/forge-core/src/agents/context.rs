//! Session-local task lists use the installed framework's closed schema.
use crate::contract::*;
use serde_json::{Value, json};
use std::sync::LazyLock;

pub const PRESERVATION_LABEL: &str = "[Your task list was preserved across context compaction]";
static DESCRIPTORS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../data/context-tools.json"))
        .expect("source context tool definitions")
});
pub fn descriptors() -> &'static [Value] {
    &DESCRIPTORS
}
pub fn input(name: &str, value: Value) -> Result<Value> {
    if name != "todo" {
        return Err(ContractError("context tool"));
    }
    let mut object = Object::new(value, &["todos"], true)?;
    object.optional("todos", items)?;
    Ok(object.finish())
}
pub fn items(value: Value) -> Result<Value> {
    let values = value.as_array().ok_or(ContractError("todos"))?;
    let mut result = Vec::with_capacity(values.len());
    for value in values {
        let mut object = Object::new(value.clone(), &["content", "priority", "status"], true)?;
        object.required("content", string)?;
        object.required("priority", |v| enumeration(v, &["high", "medium", "low"]))?;
        object.required("status", |v| {
            enumeration(v, &["pending", "in_progress", "completed", "cancelled"])
        })?;
        result.push(object.finish());
    }
    Ok(json!(result))
}
/// Caller validates the list before storing it. Reading never mutates the list.
pub fn output(todos: &[Value]) -> Value {
    let mut counts =
        json!({"cancelled":0,"completed":0,"in_progress":0,"pending":0,"total":todos.len()});
    for item in todos {
        if let Some(status) = item["status"].as_str() {
            counts[status] = json!(counts[status].as_u64().unwrap_or(0) + 1);
        }
    }
    json!({"counts":counts,"todos":todos})
}
pub fn preservation(todos: &[Value]) -> Option<Value> {
    if todos.is_empty() {
        return None;
    }
    let mut content = PRESERVATION_LABEL.to_owned();
    for item in todos {
        let mark = match item["status"].as_str() {
            Some("completed") => "x",
            Some("cancelled") => "-",
            _ => " ",
        };
        content.push_str(&format!(
            "\n- [{mark}] [{}] {}",
            item["priority"].as_str().unwrap_or(""),
            item["content"].as_str().unwrap_or("")
        ));
    }
    Some(json!({"role":"user","content":content}))
}
