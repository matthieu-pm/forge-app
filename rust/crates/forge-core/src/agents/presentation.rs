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

/// Add readable native citations within the existing public payload budget.
/// Provider reference tokens and quoted document content never enter this view.
pub fn native_sources(mut event: Value, sources: &Value) -> Result<Value, UnsafePayload> {
    if event["type"] != "assistant.message" {
        return Ok(event);
    }
    safe_payload(&event["payload"])?;
    let Some(sources) = sources.as_array().filter(|v| !v.is_empty()) else {
        return Ok(event);
    };
    let mut payload = event["payload"].clone();
    payload["sources"] = json!([]);
    payload["sourcesOmitted"] = json!(sources.len());
    if safe_payload(&payload).is_err() {
        return Ok(event);
    }
    let mut seen = std::collections::HashSet::new();
    let mut count = 0;
    for source in sources.iter().take(128) {
        let Some(raw) = source["url"].as_str().filter(|v| v.len() <= 4096) else {
            continue;
        };
        let Ok(url) = url::Url::parse(raw) else {
            continue;
        };
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || !seen.insert(url.to_string())
        {
            continue;
        }
        let Some(title) = source["title"].as_str().filter(|v| v.len() <= 1024) else {
            continue;
        };
        let mut candidate = payload.clone();
        candidate["sources"]
            .as_array_mut()
            .unwrap()
            .push(json!({"url":url.as_str(),"title":title}));
        candidate["sourcesOmitted"] = json!(sources.len() - count - 1);
        if safe_payload(&candidate).is_ok() {
            payload = candidate;
            count += 1;
        }
        if count == 32 {
            break;
        }
    }
    if count == sources.len() {
        payload.as_object_mut().unwrap().remove("sourcesOmitted");
    }
    event["payload"] = payload;
    Ok(event)
}
