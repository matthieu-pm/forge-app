use super::*;
use serde::Deserialize;
pub struct Verification {
    expected_size: usize,
    expected_checksum: String,
    declared: String,
    hash: Sha256,
    size: usize,
    head: Vec<u8>,
    text: bool,
    tail: Vec<u8>,
    json: Vec<u8>,
}
pub struct VerifiedBytes {
    pub size_bytes: usize,
    pub checksum: String,
    pub head: Vec<u8>,
    pub utf8_text: bool,
    pub declared: String,
    pub json: Vec<u8>,
}
fn controls(value: &str) -> bool {
    value
        .chars()
        .any(|c| matches!(c,'\u{0}'..='\u{8}'|'\u{b}'|'\u{c}'|'\u{e}'..='\u{1f}'))
}
impl Verification {
    pub fn new(input: &Value) -> Result<Self, UploadError> {
        let size = input["sizeBytes"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= MAX_BYTES as u64)
            .ok_or(UploadError::Invalid("Invalid file size."))? as usize;
        let checksum = input["checksum"]
            .as_str()
            .filter(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            .ok_or(UploadError::Invalid("Invalid file checksum."))?;
        let declared = input["contentType"]
            .as_str()
            .ok_or(UploadError::Invalid("Invalid content type."))?;
        Ok(Self {
            expected_size: size,
            expected_checksum: checksum.into(),
            declared: declared.into(),
            hash: Sha256::new(),
            size: 0,
            head: Vec::with_capacity(size.min(1_048_576)),
            text: true,
            tail: vec![],
            json: vec![],
        })
    }
    pub fn push(&mut self, bytes: &[u8]) -> Result<(), UploadError> {
        self.size = self
            .size
            .checked_add(bytes.len())
            .ok_or(UploadError::Invalid(
                "The stored file exceeds its reserved size.",
            ))?;
        if self.size > self.expected_size || self.size > MAX_BYTES {
            return Err(UploadError::Invalid(
                "The stored file exceeds its reserved size.",
            ));
        }
        self.hash.update(bytes);
        let take = (self.expected_size.min(1_048_576) - self.head.len()).min(bytes.len());
        self.head.extend_from_slice(&bytes[..take]);
        if self.text {
            if self.declared == "application/json" {
                self.json.extend_from_slice(bytes);
            }
            let joined = if self.tail.is_empty() {
                None
            } else {
                let mut v = std::mem::take(&mut self.tail);
                v.extend_from_slice(bytes);
                Some(v)
            };
            let data = joined.as_deref().unwrap_or(bytes);
            match std::str::from_utf8(data) {
                Ok(text) => {
                    if controls(text) {
                        self.text = false;
                    }
                }
                Err(e) => {
                    if e.error_len().is_some()
                        || controls(std::str::from_utf8(&data[..e.valid_up_to()]).unwrap())
                    {
                        self.text = false;
                    } else {
                        self.tail = data[e.valid_up_to()..].to_vec();
                    }
                }
            }
            if !self.text {
                self.json.clear();
                self.tail.clear();
            }
        }
        Ok(())
    }
    pub fn finish(self) -> Result<VerifiedBytes, UploadError> {
        let checksum = hex::encode(self.hash.finalize());
        if self.size != self.expected_size || checksum != self.expected_checksum {
            return Err(UploadError::Invalid(
                "The stored file does not match its size or SHA-256 checksum.",
            ));
        }
        Ok(VerifiedBytes {
            size_bytes: self.size,
            checksum,
            head: self.head,
            utf8_text: self.text && self.tail.is_empty(),
            declared: self.declared,
            json: self.json,
        })
    }
}
pub fn json_valid(bytes: &[u8]) -> bool {
    // IgnoredAny uses serde_json's iterative syntax walker: no recursive Value
    // allocation, numeric conversion or rejection of JSON's escaped surrogates.
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let mut parser = serde_json::Deserializer::from_slice(bytes);
    parser.disable_recursion_limit();
    serde::de::IgnoredAny::deserialize(&mut parser).is_ok() && parser.end().is_ok()
}
impl VerifiedBytes {
    /// Detection is supplied by the storage adapter; declarations confer no trust.
    pub fn classify(&self, detected: Option<&str>) -> Result<String, UploadError> {
        if self.utf8_text && self.declared == "application/json" && !json_valid(&self.json) {
            return Err(UploadError::Invalid("The file is not valid JSON."));
        }
        let text_types = [
            "text/plain",
            "text/csv",
            "text/markdown",
            "application/json",
        ];
        let actual = detected.unwrap_or(if self.utf8_text {
            if text_types.contains(&self.declared.as_str()) {
                &self.declared
            } else {
                "text/plain"
            }
        } else {
            "application/octet-stream"
        });
        if self.declared != "application/octet-stream"
            && self.declared != actual
            && actual != "application/octet-stream"
        {
            return Err(UploadError::Invalid(
                "The file's bytes do not match its declared type.",
            ));
        }
        Ok(actual.into())
    }
    pub fn metadata(&self, detected: Option<&str>) -> Result<Value, UploadError> {
        Ok(
            json!({"sizeBytes":self.size_bytes,"checksum":self.checksum,"contentType":self.classify(detected)?}),
        )
    }
}
