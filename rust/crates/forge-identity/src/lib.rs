//! Compatibility with the installed Better Auth credential formats. No database
//! or HTTP dependencies; verification never treats an unsigned cookie as a token.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use unicode_normalization::UnicodeNormalization;

const COOKIE_ENCODE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'!')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')')
    .remove(b'*')
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("The credential is invalid.")]
    Invalid,
}

fn password_key(password: &str, salt: &str) -> Result<[u8; 64], CredentialError> {
    let normalized: String = password.nfkc().collect();
    let parameters = scrypt::Params::new(14, 16, 1, 64).map_err(|_| CredentialError::Invalid)?;
    let mut key = [0; 64];
    scrypt::scrypt(
        normalized.as_bytes(),
        salt.as_bytes(),
        &parameters,
        &mut key,
    )
    .map_err(|_| CredentialError::Invalid)?;
    Ok(key)
}

pub fn hash_password(password: &str) -> Result<String, CredentialError> {
    let mut salt = [0; 16];
    OsRng.fill_bytes(&mut salt);
    let salt = hex::encode(salt);
    Ok(format!(
        "{salt}:{}",
        hex::encode(password_key(password, &salt)?)
    ))
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    let Some((salt, expected)) = hash.split_once(':') else {
        return false;
    };
    if salt.len() != 32 || expected.len() != 128 || hex::decode(salt).is_err() {
        return false;
    }
    let Ok(expected) = hex::decode(expected) else {
        return false;
    };
    password_key(password, salt)
        .map(|key| bool::from(key.as_slice().ct_eq(&expected)))
        .unwrap_or(false)
}

pub fn sign_session_token(token: &str, secret: &str) -> Result<String, CredentialError> {
    if token.is_empty() || secret.is_empty() {
        return Err(CredentialError::Invalid);
    }
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| CredentialError::Invalid)?;
    mac.update(token.as_bytes());
    let signed = format!("{token}.{}", STANDARD.encode(mac.finalize().into_bytes()));
    Ok(utf8_percent_encode(&signed, COOKIE_ENCODE).to_string())
}

pub fn verify_session_token(cookie: &str, secret: &str) -> Result<String, CredentialError> {
    if secret.is_empty() {
        return Err(CredentialError::Invalid);
    }
    let decoded = percent_decode_str(cookie)
        .decode_utf8()
        .map_err(|_| CredentialError::Invalid)?;
    let (token, signature) = decoded.rsplit_once('.').ok_or(CredentialError::Invalid)?;
    if token.is_empty() || signature.len() != 44 || !signature.ends_with('=') {
        return Err(CredentialError::Invalid);
    }
    let signature = STANDARD
        .decode(signature)
        .map_err(|_| CredentialError::Invalid)?;
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| CredentialError::Invalid)?;
    mac.update(token.as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| CredentialError::Invalid)?;
    Ok(token.to_owned())
}

pub fn session_token_from_cookies(
    header: &str,
    secure: bool,
    secret: &str,
) -> Result<String, CredentialError> {
    let expected = if secure {
        "__Secure-better-auth.session_token"
    } else {
        "better-auth.session_token"
    };
    let mut values = header
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .filter(|(name, _)| *name == expected)
        .map(|(_, value)| value);
    let cookie = values.next().ok_or(CredentialError::Invalid)?;
    if values.next().is_some() {
        return Err(CredentialError::Invalid);
    }
    verify_session_token(cookie, secret)
}

pub fn bearer_credential(authorization: &str) -> Option<&str> {
    let first_space = authorization.find(char::is_whitespace)?;
    if !authorization[..first_space].eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = authorization[first_space..].trim_start_matches(char::is_whitespace);
    (!token.is_empty() && !token.chars().any(char::is_whitespace)).then_some(token)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailVerificationClaims {
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_type: Option<String>,
    pub iat: i64,
    pub exp: i64,
}

pub fn email_verification_token(
    email: &str,
    secret: &str,
    now: i64,
) -> Result<String, CredentialError> {
    let claims = EmailVerificationClaims {
        email: email.to_lowercase(),
        update_to: None,
        request_type: None,
        iat: now,
        exp: now.checked_add(3600).ok_or(CredentialError::Invalid)?,
    };
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256"}"#);
    let payload =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|_| CredentialError::Invalid)?);
    let input = format!("{header}.{payload}");
    if secret.is_empty() {
        return Err(CredentialError::Invalid);
    }
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| CredentialError::Invalid)?;
    mac.update(input.as_bytes());
    Ok(format!(
        "{input}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    ))
}

pub fn verify_email_token(
    token: &str,
    secret: &str,
    now: i64,
) -> Result<EmailVerificationClaims, CredentialError> {
    if token.len() > 16_384 || secret.is_empty() {
        return Err(CredentialError::Invalid);
    }
    let mut parts = token.split('.');
    let header = parts.next().ok_or(CredentialError::Invalid)?;
    let payload = parts.next().ok_or(CredentialError::Invalid)?;
    let signature = parts.next().ok_or(CredentialError::Invalid)?;
    if parts.next().is_some() {
        return Err(CredentialError::Invalid);
    }
    let header_json: serde_json::Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(header)
            .map_err(|_| CredentialError::Invalid)?,
    )
    .map_err(|_| CredentialError::Invalid)?;
    if header_json.get("alg").and_then(serde_json::Value::as_str) != Some("HS256")
        || header_json.get("crit").is_some()
    {
        return Err(CredentialError::Invalid);
    }
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| CredentialError::Invalid)?;
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| CredentialError::Invalid)?;
    mac.update(format!("{header}.{payload}").as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| CredentialError::Invalid)?;
    let claims: EmailVerificationClaims = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|_| CredentialError::Invalid)?,
    )
    .map_err(|_| CredentialError::Invalid)?;
    if claims.exp <= now || claims.email.is_empty() {
        return Err(CredentialError::Invalid);
    }
    Ok(claims)
}
