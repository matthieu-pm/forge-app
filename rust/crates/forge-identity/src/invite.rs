use crate::CredentialError;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InviteClaims {
    pub generation: i32,
    pub workspace_id: String,
}

fn key(secret: &str) -> Result<Vec<u8>, CredentialError> {
    if secret.encode_utf16().count() < 32 {
        return Err(CredentialError::Invalid);
    }
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| CredentialError::Invalid)?;
    mac.update(b"forge-workspace-invite-link:v1");
    Ok(mac.finalize().into_bytes().to_vec())
}
impl InviteClaims {
    fn validate(&self) -> Result<(), CredentialError> {
        if self.generation <= 0 || self.workspace_id.is_empty() {
            return Err(CredentialError::Invalid);
        }
        Ok(())
    }
    pub fn sign(&self, secret: &str) -> Result<String, CredentialError> {
        self.validate()?;
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"forge-workspace-invite"}"#);
        let payload =
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(self).map_err(|_| CredentialError::Invalid)?);
        let input = format!("{header}.{payload}");
        let mut mac =
            Hmac::<Sha256>::new_from_slice(&key(secret)?).map_err(|_| CredentialError::Invalid)?;
        mac.update(input.as_bytes());
        Ok(format!(
            "{input}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        ))
    }
    pub fn verify(token: &str, secret: &str) -> Result<Self, CredentialError> {
        if token.len() > 16384 {
            return Err(CredentialError::Invalid);
        }
        let parts: Vec<_> = token.split('.').collect();
        if parts.len() != 3 {
            return Err(CredentialError::Invalid);
        }
        let decode = |part: &str| {
            URL_SAFE_NO_PAD
                .decode(part)
                .map_err(|_| CredentialError::Invalid)
        };
        let header: serde_json::Value =
            serde_json::from_slice(&decode(parts[0])?).map_err(|_| CredentialError::Invalid)?;
        if header["alg"] != "HS256"
            || header["typ"] != "forge-workspace-invite"
            || header.get("crit").is_some()
            || header.get("b64").is_some()
        {
            return Err(CredentialError::Invalid);
        }
        let mut mac =
            Hmac::<Sha256>::new_from_slice(&key(secret)?).map_err(|_| CredentialError::Invalid)?;
        mac.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
        mac.verify_slice(&decode(parts[2])?)
            .map_err(|_| CredentialError::Invalid)?;
        let claims: Self =
            serde_json::from_slice(&decode(parts[1])?).map_err(|_| CredentialError::Invalid)?;
        claims.validate()?;
        Ok(claims)
    }
}
