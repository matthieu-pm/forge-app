//! Existing AES-256-GCM credential envelopes, bound to workspace:connection AAD.
//! Keys and plaintexts deliberately have no Debug or serialization implementation.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{RngCore, rngs::OsRng};
use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};

#[derive(Debug, thiserror::Error)]
#[error("The credential vault operation failed.")]
pub struct Error;
pub struct Vault(LessSafeKey);
impl Vault {
    pub fn new(encoded: &str) -> Result<Self, Error> {
        let key = decode(encoded);
        if key.len() != 32 {
            return Err(Error);
        }
        Ok(Self(LessSafeKey::new(
            UnboundKey::new(&aead::AES_256_GCM, &key).map_err(|_| Error)?,
        )))
    }
    pub fn seal(&self, secret: &str, context: &str) -> Result<String, Error> {
        let mut nonce = [0; 12];
        OsRng.fill_bytes(&mut nonce);
        self.encrypt(secret, context, nonce)
    }
    fn encrypt(&self, secret: &str, context: &str, nonce: [u8; 12]) -> Result<String, Error> {
        let mut bytes = secret.as_bytes().to_vec();
        let tag = self
            .0
            .seal_in_place_separate_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(context.as_bytes()),
                &mut bytes,
            )
            .map_err(|_| Error)?;
        Ok(format!(
            "forge-model-secret:v1:{}:{}:{}",
            URL_SAFE_NO_PAD.encode(nonce),
            URL_SAFE_NO_PAD.encode(tag.as_ref()),
            URL_SAFE_NO_PAD.encode(bytes)
        ))
    }
    pub fn open(&self, reference: &str, context: &str) -> Result<String, Error> {
        let mut parts = reference.split(':');
        if parts.next() != Some("forge-model-secret") || parts.next() != Some("v1") {
            return Err(Error);
        }
        let nonce = parts.next().filter(|s| !s.is_empty()).ok_or(Error)?;
        let tag = parts.next().filter(|s| !s.is_empty()).ok_or(Error)?;
        let content = parts.next().filter(|s| !s.is_empty()).ok_or(Error)?;
        let nonce: [u8; 12] = decode(nonce).try_into().map_err(|_| Error)?;
        let tag = decode(tag);
        if tag.len() != 16 {
            return Err(Error);
        }
        let mut bytes = decode(content);
        bytes.extend(tag);
        let plaintext = self
            .0
            .open_in_place(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(context.as_bytes()),
                &mut bytes,
            )
            .map_err(|_| Error)?;
        Ok(String::from_utf8_lossy(plaintext).into_owned())
    }
}
fn decode(value: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut bits = 0u32;
    let mut count = 0;
    for b in value.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(v);
        count += 6;
        if count >= 8 {
            count -= 8;
            bytes.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    bytes
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_envelopes_and_context_binding_match_reference() {
        let data: serde_json::Value =
            serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap();
        for case in data["modelProviders"]["vault"].as_array().unwrap() {
            let vault = Vault::new(case["key"].as_str().unwrap()).unwrap();
            let secret = case["secret"].as_str().unwrap();
            let context = case["context"].as_str().unwrap();
            let nonce: Vec<u8> = serde_json::from_value(case["nonce"].clone()).unwrap();
            assert_eq!(
                vault
                    .encrypt(secret, context, nonce.try_into().unwrap())
                    .unwrap(),
                case["reference"]
            );
            if !secret.is_empty() {
                assert_eq!(
                    vault
                        .open(case["reference"].as_str().unwrap(), context)
                        .unwrap(),
                    secret
                );
                assert!(
                    vault
                        .open(case["reference"].as_str().unwrap(), "different-context")
                        .is_err()
                );
                let mut pieces: Vec<String> = case["reference"]
                    .as_str()
                    .unwrap()
                    .split(':')
                    .map(str::to_owned)
                    .collect();
                let mut encrypted = decode(&pieces[4]);
                encrypted[0] ^= 1;
                pieces[4] = URL_SAFE_NO_PAD.encode(encrypted);
                assert!(vault.open(&pieces.join(":"), context).is_err());
            }
            let fresh = vault.seal(secret, context).unwrap();
            assert_ne!(fresh, case["reference"]);
        }
        for key in ["", "short", "aGVsbG8="] {
            assert!(Vault::new(key).is_err());
        }
    }
}
