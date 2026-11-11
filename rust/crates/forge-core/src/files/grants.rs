use super::*;
use crate::{actor::Actor, canonical::javascript_stringify};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
fn key(secret: &str) -> Result<Hmac<Sha256>, DeliveryError> {
    if secret.encode_utf16().count() < 32 {
        return Err(DeliveryError::InvalidGrant);
    }
    Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| DeliveryError::InvalidGrant)
}
pub fn mint(
    secret: &str,
    a: &Actor,
    target: &Value,
    purpose: &str,
    now: i64,
) -> Result<String, DeliveryError> {
    delivery_target(target.clone()).map_err(|_| DeliveryError::InvalidGrant)?;
    if !["download", "preview"].contains(&purpose) {
        return Err(DeliveryError::InvalidGrant);
    }
    let exp = now
        .checked_add(GRANT_SECONDS)
        .ok_or(DeliveryError::InvalidGrant)?;
    let payload = json!({"workspaceId":a.workspace_id,"kind":target["kind"],"fileId":target["id"],"purpose":purpose,"sub":a.user_id,"iss":"forge","aud":"forge-private-file","iat":now,"exp":exp});
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(javascript_stringify(&payload));
    let input = format!("{header}.{payload}");
    let mut mac = key(secret)?;
    mac.update(input.as_bytes());
    Ok(format!(
        "{input}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}
pub fn verify(
    secret: &str,
    token: &str,
    a: &Actor,
    target: &Value,
    purpose: &str,
    now: i64,
) -> Result<(), DeliveryError> {
    let invalid = DeliveryError::InvalidGrant;
    if token.len() > 16_384 {
        return Err(invalid);
    }
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(invalid);
    }
    let header: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).map_err(|_| invalid)?)
            .map_err(|_| invalid)?;
    if header["alg"] != "HS256" || header.get("crit").is_some() || header["b64"] == false {
        return Err(invalid);
    }
    let mut mac = key(secret)?;
    mac.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
    mac.verify_slice(&URL_SAFE_NO_PAD.decode(parts[2]).map_err(|_| invalid)?)
        .map_err(|_| invalid)?;
    let claims: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).map_err(|_| invalid)?)
            .map_err(|_| invalid)?;
    let iat = claims["iat"].as_f64().ok_or(invalid)?;
    let exp = claims["exp"].as_f64().ok_or(invalid)?;
    let current = now as f64;
    let audience = claims["aud"] == "forge-private-file"
        || claims["aud"]
            .as_array()
            .is_some_and(|aud| aud.iter().any(|v| v == "forge-private-file"));
    if claims["iss"] != "forge"
        || !audience
        || claims["sub"] != a.user_id
        || claims["workspaceId"] != a.workspace_id
        || claims["kind"] != target["kind"]
        || claims["fileId"] != target["id"]
        || claims["purpose"] != purpose
        || iat > current
        || current - iat > GRANT_SECONDS as f64
        || exp <= current
        || exp - iat > GRANT_SECONDS as f64
        || claims
            .get("nbf")
            .is_some_and(|v| v.as_f64().is_none_or(|nbf| nbf > current))
    {
        return Err(invalid);
    }
    Ok(())
}
