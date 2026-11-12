//! The pinned Polar SDK's signed-event boundary. Authenticated event payloads
//! supply identity only; the event adapter must re-fetch current provider proof.
use super::{Client, Clock, Error};
use async_trait::async_trait;
use axum::{
    Json,
    body::Body,
    http::{HeaderMap, Method, Request, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{
    Engine, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, LazyLock};

const MAX_BODY_BYTES: usize = 1_048_576;
static KNOWN_EVENTS: LazyLock<Vec<String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../forge-core/data/billing-polar-webhook-events.json"
    ))
    .expect("pinned Polar SDK webhook event types")
});
const BILLING_EVENTS: &[&str] = &[
    "order.refunded",
    "order.paid",
    "subscription.active",
    "subscription.revoked",
    "subscription.past_due",
    "subscription.updated",
    "subscription.canceled",
    "subscription.uncanceled",
    "subscription.paused",
    "subscription.resumed",
];

#[async_trait]
pub trait Events: Send + Sync {
    async fn subscription(&self, identity: &Value) -> Result<Value, Error>;
    async fn order(&self, _identity: &Value) -> Result<Value, Error> {
        Err(Error("BILLING_ORDER_RECONCILIATION_REQUIRED"))
    }
    async fn refund(&self, identity: &Value) -> Result<Value, Error>;
}

pub struct Handler {
    pub client: Option<Arc<Client>>,
    pub events: Arc<dyn Events>,
    pub now: Clock,
}

fn response(status: StatusCode, code: &'static str) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"code":code})),
    )
        .into_response()
}
fn invalid() -> Error {
    Error("INVALID_WEBHOOK")
}
// Fetch Headers.get combines repeated fields with comma-space. Preserve that
// behavior, including duplicate timestamps becoming an invalid numeric value.
fn header_value(headers: &HeaderMap, name: &str) -> String {
    headers
        .get_all(name)
        .iter()
        .map(|value| {
            value
                .as_bytes()
                .iter()
                .map(|byte| char::from(*byte))
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join(", ")
}
// WHATWG atob's forgiving-base64 decoding: only ASCII whitespace is discarded,
// unpadded input and nonzero unused bits are accepted, and URL-safe input is not.
fn base64_bytes(value: &str) -> Option<Vec<u8>> {
    let mut encoded: Vec<u8> = value
        .bytes()
        .filter(|byte| !matches!(byte, b'\t' | b'\n' | b'\x0c' | b'\r' | b' '))
        .collect();
    if encoded.len().is_multiple_of(4) {
        for _ in 0..2 {
            if encoded.last() == Some(&b'=') {
                encoded.pop();
            }
        }
    }
    if encoded.len() % 4 == 1
        || encoded
            .iter()
            .any(|byte| !(byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/')))
    {
        return None;
    }
    GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::RequireNone)
            .with_decode_allow_trailing_bits(true),
    )
    .decode(encoded)
    .ok()
}
fn number(value: &str) -> Option<f64> {
    let value = forge_core::text::trim(value);
    if value.is_empty() {
        return Some(0.);
    }
    let prefixed = [("0x", "0X", 16_u32), ("0b", "0B", 2), ("0o", "0O", 8)];
    for (lower, upper, radix) in prefixed {
        if let Some(digits) = value
            .strip_prefix(lower)
            .or_else(|| value.strip_prefix(upper))
        {
            if digits.is_empty() {
                return None;
            }
            let mut result = 0.0;
            for digit in digits.chars() {
                result = result * f64::from(radix) + f64::from(digit.to_digit(radix)?);
            }
            return result.is_finite().then_some(result);
        }
    }
    value.parse::<f64>().ok().filter(|n| n.is_finite())
}
fn verified_event(
    raw: &[u8],
    headers: &HeaderMap,
    secret: &str,
    now: DateTime<Utc>,
) -> Result<Value, Error> {
    let id = header_value(headers, "webhook-id");
    let timestamp = header_value(headers, "webhook-timestamp");
    let signatures = header_value(headers, "webhook-signature");
    if secret.is_empty() || id.is_empty() || timestamp.is_empty() || signatures.is_empty() {
        return Err(invalid());
    }
    let timestamp = number(&timestamp).ok_or_else(invalid)?;
    let seconds = now.timestamp_millis() as f64 / 1000.;
    if timestamp < seconds - 300. || timestamp > seconds + 300. {
        return Err(invalid());
    }
    // SDK decoding replaces malformed UTF-8 and strips one leading BOM before
    // signing. The durable body digest below remains over the original bytes.
    let decoded = String::from_utf8_lossy(raw);
    let text = decoded.strip_prefix('\u{feff}').unwrap_or(&decoded);
    let floor = timestamp.floor();
    let signed_second = if floor == 0. {
        "0".into()
    } else {
        format!("{floor:.0}")
    };
    let signed = format!("{id}.{signed_second}.{text}");
    let mut keys = vec![secret.as_bytes().to_vec()];
    if let Some(key) = base64_bytes(secret.strip_prefix("whsec_").unwrap_or(secret))
        .filter(|key| !key.is_empty() && key.as_slice() != secret.as_bytes())
    {
        keys.push(key);
    }
    let verified = signatures.split(' ').any(|candidate| {
        let mut parts = candidate.split(',');
        if parts.next() != Some("v1") {
            return false;
        }
        let Some(signature) = parts.next().and_then(base64_bytes) else {
            return false;
        };
        keys.iter().any(|key| {
            let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key size");
            mac.update(signed.as_bytes());
            mac.verify_slice(&signature).is_ok()
        })
    });
    if !verified {
        return Err(invalid());
    }
    let event = forge_core::json::parse(text).map_err(|_| invalid())?;
    if !event["type"]
        .as_str()
        .is_some_and(|kind| KNOWN_EVENTS.iter().any(|known| known == kind))
    {
        return Err(invalid());
    }
    Ok(event)
}

impl Handler {
    pub async fn handle(&self, request: Request<Body>) -> Response {
        let Some(client) = self.client.as_ref().filter(|client| client.config.enabled) else {
            return response(StatusCode::NOT_FOUND, "NOT_FOUND");
        };
        if request.method() != Method::POST {
            return response(StatusCode::METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED");
        }
        let (parts, body) = request.into_parts();
        let mut stream = body.into_data_stream();
        let mut raw = Vec::new();
        while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else {
                return response(StatusCode::BAD_REQUEST, "INVALID_WEBHOOK");
            };
            if chunk.len() > MAX_BODY_BYTES - raw.len() {
                return response(StatusCode::PAYLOAD_TOO_LARGE, "WEBHOOK_TOO_LARGE");
            }
            raw.extend_from_slice(&chunk);
        }
        let Ok(event) = verified_event(
            &raw,
            &parts.headers,
            &client.config.webhook_secret,
            (self.now)(),
        ) else {
            return response(StatusCode::BAD_REQUEST, "INVALID_WEBHOOK");
        };
        let kind = event["type"].as_str().expect("verified event type");
        let id = event["data"]["id"].as_str();
        let customer = event["data"]["customer"]["external_id"].as_str();
        if !BILLING_EVENTS.contains(&kind)
            || !id.is_some_and(forge_core::text::is_uuid)
            || !customer.is_some_and(|value| (1..=255).contains(&value.encode_utf16().count()))
        {
            return response(
                StatusCode::SERVICE_UNAVAILABLE,
                "BILLING_EVENT_POLICY_REQUIRED",
            );
        }
        let Some(workspace) = customer
            .unwrap()
            .strip_prefix("forge:workspace:")
            .filter(|workspace| !forge_core::text::trim(workspace).is_empty())
        else {
            return response(StatusCode::BAD_REQUEST, "INVALID_BILLING_IDENTITY");
        };
        let mut identity = json!({
            "workspaceId": workspace,
            "eventId": header_value(&parts.headers, "webhook-id"),
            "bodyHash": format!("{:x}",Sha256::digest(&raw)),
        });
        let result = match kind {
            "order.refunded" => {
                identity["orderId"] = json!(id.unwrap());
                self.events.refund(&identity).await
            }
            "order.paid" => {
                identity["orderId"] = json!(id.unwrap());
                self.events.order(&identity).await
            }
            _ => {
                identity["subscriptionId"] = json!(id.unwrap());
                if kind == "subscription.resumed" {
                    identity["unsupportedResume"] = json!(true);
                }
                self.events.subscription(&identity).await
            }
        };
        if result.is_ok() {
            response(StatusCode::OK, "RECONCILED")
        } else {
            response(
                StatusCode::SERVICE_UNAVAILABLE,
                "BILLING_RECONCILIATION_REQUIRED",
            )
        }
    }
}
