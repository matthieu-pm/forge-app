//! Source delivery ordering and payload merging. Auth values are opaque data;
//! these helpers never authorize a tool or retain a runtime credential.
use super::pending_input;
use serde_json::{Map, Value};
use std::collections::VecDeque;

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("Invalid runtime delivery batch.")]
pub struct Error;
pub type Result<T> = std::result::Result<T, Error>;

/// EVE retains the first delivery identity and the last explicitly supplied
/// authority, and allows at most one caller-bearing delivery in a batch.
pub fn coalesce_deliveries(deliveries: &[Value]) -> Result<Value> {
    let first = deliveries.first().ok_or(Error)?;
    let mut result = first.as_object().ok_or(Error)?.clone();
    let mut payloads = first["payloads"].as_array().ok_or(Error)?.clone();
    for delivery in &deliveries[1..] {
        let delivery = delivery.as_object().ok_or(Error)?;
        if let Some(auth) = delivery.get("auth") {
            result.insert("auth".into(), auth.clone());
        }
        if let Some(caller) = delivery.get("caller") {
            if result.contains_key("caller") {
                return Err(Error);
            }
            result.insert("caller".into(), caller.clone());
        }
        payloads.extend(
            delivery
                .get("payloads")
                .and_then(Value::as_array)
                .ok_or(Error)?
                .iter()
                .cloned(),
        );
    }
    result.insert("payloads".into(), Value::Array(payloads));
    Ok(Value::Object(result))
}

/// Remove the same FIFO prefix as the source parked-delivery receiver. Run or
/// authority changes do not split a prefix; a second defined caller does.
pub fn take_prefix(deliveries: &mut VecDeque<Value>) -> Result<Option<Value>> {
    let Some(first) = deliveries.pop_front() else {
        return Ok(None);
    };
    let mut caller = first.get("caller").cloned();
    let mut prefix = vec![first];
    while let Some(next) = deliveries.front() {
        if caller.is_some() && next.get("caller").is_some() {
            break;
        }
        let next = deliveries.pop_front().ok_or(Error)?;
        if caller.as_ref().is_none_or(Value::is_null) {
            caller = next.get("caller").cloned();
        }
        prefix.push(next);
    }
    coalesce_deliveries(&prefix).map(Some)
}

/// Unlike turn-input merging, a singleton payload retains its extra fields and
/// exact shape. In a batch, known input fields merge and other fields last-win.
pub fn coalesce_payloads(payloads: &[Value]) -> Result<Value> {
    let Some(first) = payloads.first() else {
        return Ok(Value::Object(Map::new()));
    };
    if payloads.len() == 1 {
        return Ok(if first.is_null() {
            Value::Object(Map::new())
        } else {
            first.clone()
        });
    }
    let mut extras = Map::new();
    let mut merged = Value::Object(Map::new());
    for payload in payloads {
        extras.extend(payload.as_object().ok_or(Error)?.clone());
        merged = pending_input::coalesce(&merged, payload).map_err(|_| Error)?;
    }
    for key in ["context", "inputResponses", "message", "outputSchema"] {
        extras.remove(key);
    }
    extras.extend(merged.as_object().ok_or(Error)?.clone());
    Ok(Value::Object(extras))
}
