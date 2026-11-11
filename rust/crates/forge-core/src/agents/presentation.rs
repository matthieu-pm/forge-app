//! Native tool events keep display data bounded independently from the private
//! model conversation. Approval inputs are never projected or partially shown.
use super::contracts::{UnsafePayload, safe_payload};
use crate::canonical::javascript_stringify;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub fn approval_input(input: &Value) -> Result<(), UnsafePayload> {
    // Reserve space for the complete request's IDs, labels and binding hash.
    if javascript_stringify(input).len() > 120 * 1024 {
        return Err(UnsafePayload::TooLarge);
    }
    safe_payload(input)
}
pub fn native_event(mut event: Value) -> Result<Value, UnsafePayload> {
    if let Some(id) = event["sourceEventId"].as_str()
        && (crate::text::length(id) > 255 || crate::text::trim(id) != id)
    {
        // Provider call IDs may exceed the public receipt's 255-character
        // boundary. Keep the call binding intact and derive a stable receipt ID.
        event["sourceEventId"] = json!(format!(
            "native-receipt:{:x}",
            Sha256::digest(id.as_bytes())
        ));
    }
    let Err(reason) = safe_payload(&event["payload"]) else {
        return Ok(event);
    };
    if !matches!(
        event["type"].as_str(),
        Some(
            "tool.started"
                | "tool.completed"
                | "tool.failed"
                | "code.started"
                | "code.completed"
                | "file.search.started"
                | "file.search.completed"
                | "file.read"
                | "file.patch.proposed"
                | "file.patch.applied"
        )
    ) {
        return Err(reason);
    }
    let notice = match reason {
        UnsafePayload::TooLarge => "The tool data is too large to display inline.",
        UnsafePayload::Sensitive => {
            "The tool data was omitted because it contains authentication information."
        }
    };
    let Some(payload) = event["payload"].as_object_mut() else {
        return Err(reason);
    };
    for key in ["input", "output"] {
        if payload.contains_key(key) {
            payload.insert(
                key.into(),
                if key == "output" {
                    json!({"type":"text","value":notice})
                } else {
                    json!({"omitted":true,"notice":notice})
                },
            );
        }
    }
    payload.insert("displayDataOmitted".into(), json!(true));
    // Never hide an unsafe call identity or other metadata, or change approval
    // semantics. Such events still fail closed instead of bypassing the guard.
    safe_payload(&event["payload"])?;
    Ok(event)
}
