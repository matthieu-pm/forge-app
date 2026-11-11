//! Private providers capture credentials once and never follow redirects.
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use forge_core::files::{self, DeliveryError, UploadError, delivery, upload};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use url::Url;
#[derive(Clone)]
pub struct Storage {
    backend: Arc<Backend>,
}
enum Backend {
    Local(PathBuf),
    Private {
        client: reqwest::Client,
        token: String,
        store: String,
        api: Url,
        origin: Box<Url>,
    },
}
pub fn configuration(env: &HashMap<String, String>) -> Result<&str, &'static str> {
    let value = |k: &str| env.get(k).map(String::as_str).unwrap_or("");
    let deployed = value("NODE_ENV") == "production"
        || value("VERCEL") == "1"
        || !value("VERCEL_ENV").is_empty()
        || (!value("FORGE_ENVIRONMENT").is_empty() && value("FORGE_ENVIRONMENT") != "development");
    let adapter = env
        .get("FORGE_AGENT_BLOB_ADAPTER")
        .filter(|v| !v.is_empty())
        .map(String::as_str)
        .unwrap_or(if deployed { "vercel-private" } else { "local" });
    if !matches!(adapter, "local" | "vercel-private") || (deployed && adapter == "local") {
        return Err("Invalid private file storage adapter.");
    }
    if adapter == "vercel-private" {
        let store = value("BLOB_STORE_ID");
        let token = value("BLOB_READ_WRITE_TOKEN");
        let valid = store
            .strip_prefix("store_")
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_alphanumeric()));
        if !valid
            || forge_core::text::trim(token).is_empty()
            || token.split('_').nth(3) != store.strip_prefix("store_")
        {
            return Err("Invalid private file storage configuration. Values are redacted.");
        }
    }
    Ok(adapter)
}
impl Storage {
    pub fn from_environment() -> Result<Self, &'static str> {
        Self::from_config(&std::env::vars().collect())
    }
    pub fn from_config(env: &HashMap<String, String>) -> Result<Self, &'static str> {
        if configuration(env)? == "local" {
            return Self::local(
                env.get("FORGE_AGENT_ARTIFACT_DIRECTORY")
                    .map(String::as_str)
                    .unwrap_or(".forge/agent-artifacts"),
            );
        }
        let store = env["BLOB_STORE_ID"].trim_start_matches("store_");
        Self::private(
            env["BLOB_READ_WRITE_TOKEN"].clone(),
            store.into(),
            Url::parse("https://vercel.com/api/blob/").unwrap(),
            Url::parse(&format!("https://{store}.private.blob.vercel-storage.com/"))
                .map_err(|_| "Invalid storage hostname.")?,
        )
    }
    pub fn local(root: impl AsRef<Path>) -> Result<Self, &'static str> {
        let root = if root.as_ref().is_absolute() {
            root.as_ref().to_owned()
        } else {
            std::env::current_dir()
                .map_err(|_| "Unavailable file directory.")?
                .join(root)
        };
        Ok(Self {
            backend: Arc::new(Backend::Local(root)),
        })
    }
    /// Explicit endpoints allow isolated provider acceptance against a loopback
    /// server. Production composition supplies fixed HTTPS provider origins.
    pub fn private(
        token: String,
        store: String,
        api: Url,
        origin: Url,
    ) -> Result<Self, &'static str> {
        for url in [&api, &origin] {
            if !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || !(url.scheme() == "https"
                    || (url.scheme() == "http" && url.host_str() == Some("127.0.0.1")))
            {
                return Err("Invalid private storage endpoint.");
            }
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| "Unavailable private storage client.")?;
        Ok(Self {
            backend: Arc::new(Backend::Private {
                client,
                token,
                store,
                api,
                origin: Box::new(origin),
            }),
        })
    }
    pub fn is_local(&self) -> bool {
        matches!(&*self.backend, Backend::Local(_))
    }
    fn reference(reference: &str) -> Result<(), UploadError> {
        if files::reference(reference) {
            Ok(())
        } else {
            Err(UploadError::Invalid("Invalid file storage reference."))
        }
    }
    fn path(&self, reference: &str) -> Result<PathBuf, UploadError> {
        Self::reference(reference)?;
        match &*self.backend {
            Backend::Local(root) => Ok(root.join(reference)),
            _ => Err(UploadError::Invalid(
                "File bytes must be uploaded directly to private storage.",
            )),
        }
    }
    pub async fn put(&self, reference: &str, bytes: Vec<u8>) -> Result<(), UploadError> {
        Self::reference(reference)?;
        if bytes.len() > files::MAX_BYTES {
            return Err(UploadError::Invalid("Invalid file size."));
        }
        match &*self.backend {
            Backend::Local(_) => {
                let (mut file, mut cleanup) = self.destination(reference).await?;
                file.write_all(&bytes)
                    .await
                    .map_err(|_| UploadError::Transport)?;
                file.flush().await.map_err(|_| UploadError::Transport)?;
                cleanup.0 = None;
                Ok(())
            }
            Backend::Private {
                client,
                token,
                store,
                api,
                ..
            } => {
                let mut url = api.clone();
                url.query_pairs_mut()
                    .append_pair("pathname", &format!("forge/{reference}"));
                let response = client
                    .put(url)
                    .bearer_auth(token)
                    .header("x-api-version", "13")
                    .header("x-vercel-blob-store-id", store)
                    .header("x-vercel-blob-access", "private")
                    .header("x-content-type", "application/octet-stream")
                    .header("x-add-random-suffix", "0")
                    .header("x-allow-overwrite", "0")
                    .body(bytes)
                    .send()
                    .await
                    .map_err(|_| UploadError::Transport)?;
                if !response.status().is_success() {
                    return Err(UploadError::Transport);
                }
                Ok(())
            }
        }
    }
    async fn destination(
        &self,
        reference: &str,
    ) -> Result<(tokio::fs::File, Cleanup), UploadError> {
        let path = self.path(reference)?;
        let parent = path.parent().ok_or(UploadError::Transport)?;
        let mut dirs = tokio::fs::DirBuilder::new();
        dirs.recursive(true);
        #[cfg(unix)]
        dirs.mode(0o700);
        dirs.create(parent)
            .await
            .map_err(|_| UploadError::Transport)?;
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let file = options
            .open(&path)
            .await
            .map_err(|_| UploadError::Transport)?;
        Ok((file, Cleanup(Some(path))))
    }
    pub async fn write_local(
        &self,
        intent: &upload::Intent,
        mut body: axum::body::Body,
    ) -> Result<(), UploadError> {
        use http_body_util::BodyExt;
        if !self.is_local() {
            return Err(UploadError::Invalid(
                "File bytes must be uploaded directly to private storage.",
            ));
        }
        if intent.state != "pending"
            || intent
                .token_expires_at
                .is_none_or(|t| t <= chrono::Utc::now())
        {
            return Err(UploadError::Invalid(
                "Request a new upload token before sending bytes.",
            ));
        }
        let (mut file, mut cleanup) = self.destination(&intent.storage_reference).await?;
        let bound = intent.input["sizeBytes"]
            .as_u64()
            .ok_or(UploadError::Transport)? as usize;
        let write = async {
            let mut received = 0usize;
            while let Some(frame) = body.frame().await {
                let frame = frame.map_err(|_| UploadError::Transport)?;
                if let Ok(bytes) = frame.into_data() {
                    received = received
                        .checked_add(bytes.len())
                        .ok_or(UploadError::Transport)?;
                    if received > bound {
                        return Err(UploadError::Invalid("The file exceeds its reserved size."));
                    }
                    file.write_all(&bytes)
                        .await
                        .map_err(|_| UploadError::Transport)?;
                }
            }
            file.flush().await.map_err(|_| UploadError::Transport)
        };
        tokio::time::timeout(Duration::from_secs(30), write)
            .await
            .map_err(|_| UploadError::Transport)??;
        cleanup.0 = None;
        Ok(())
    }
}
struct Cleanup(Option<PathBuf>);
impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Some(path) = self.0.take()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            runtime.spawn(async move {
                let _ = tokio::fs::remove_file(path).await;
            });
        }
    }
}
enum Reader {
    Local(tokio::fs::File),
    Private(reqwest::Response),
    Closed,
}
#[async_trait]
impl upload::Reader for Reader {
    async fn next(&mut self) -> Result<Option<Vec<u8>>, UploadError> {
        match self {
            Self::Local(file) => {
                let mut bytes = vec![0; 64 * 1024];
                let n = file
                    .read(&mut bytes)
                    .await
                    .map_err(|_| UploadError::Transport)?;
                bytes.truncate(n);
                Ok((n > 0).then_some(bytes))
            }
            Self::Private(response) => response
                .chunk()
                .await
                .map(|v| v.map(|b| b.to_vec()))
                .map_err(|_| UploadError::Transport),
            Self::Closed => Ok(None),
        }
    }
    async fn cancel(&mut self) -> Result<(), UploadError> {
        *self = Self::Closed;
        Ok(())
    }
}
#[async_trait]
impl upload::Transport for Storage {
    async fn grant(&self, i: &upload::Intent) -> Result<Value, UploadError> {
        Self::reference(&i.storage_reference)?;
        let until = i
            .token_expires_at
            .ok_or(UploadError::Transport)?
            .timestamp_millis();
        match &*self.backend {
            Backend::Local(_) => Ok(
                json!({"adapter":"local","url":format!("/api/files/uploads/{}/bytes",i.id),"validUntil":until,"maximumSizeInBytes":i.input["sizeBytes"]}),
            ),
            Backend::Private { token, store, .. } => {
                let path = format!("forge/{}", i.storage_reference);
                let payload = json!({"pathname":path,"validUntil":until,"maximumSizeInBytes":i.input["sizeBytes"],"allowedContentTypes":["application/octet-stream"],"addRandomSuffix":false,"allowOverwrite":false});
                let payload = STANDARD
                    .encode(serde_json::to_vec(&payload).map_err(|_| UploadError::Transport)?);
                let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes())
                    .map_err(|_| UploadError::Transport)?;
                mac.update(payload.as_bytes());
                let signature = hex::encode(mac.finalize().into_bytes());
                Ok(
                    json!({"adapter":"vercel-private","pathname":path,"validUntil":until,"maximumSizeInBytes":i.input["sizeBytes"],"token":format!("vercel_blob_client_{store}_{}",STANDARD.encode(format!("{signature}.{payload}")))}),
                )
            }
        }
    }
    async fn read(&self, reference: &str) -> Result<Option<Box<dyn upload::Reader>>, UploadError> {
        Self::reference(reference)?;
        let reader = match &*self.backend {
            Backend::Local(_) => match tokio::fs::File::open(self.path(reference)?).await {
                Ok(f) => Reader::Local(f),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(_) => return Err(UploadError::Transport),
            },
            Backend::Private {
                client,
                token,
                origin,
                ..
            } => {
                let mut url = origin
                    .join(&format!("forge/{reference}"))
                    .map_err(|_| UploadError::Transport)?;
                url.query_pairs_mut().append_pair("cache", "0");
                let response = client
                    .get(url)
                    .bearer_auth(token)
                    .send()
                    .await
                    .map_err(|_| UploadError::Transport)?;
                if response.status() == 404 {
                    return Ok(None);
                }
                if response.status() != 200 {
                    return Err(UploadError::Transport);
                }
                Reader::Private(response)
            }
        };
        Ok(Some(Box::new(reader)))
    }
    async fn delete(&self, reference: &str) -> Result<(), UploadError> {
        Self::reference(reference)?;
        match &*self.backend {
            Backend::Local(_) => match tokio::fs::remove_file(self.path(reference)?).await {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(_) => Err(UploadError::Transport),
            },
            Backend::Private {
                client,
                token,
                store,
                api,
                ..
            } => {
                let response = client
                    .post(api.join("delete").map_err(|_| UploadError::Transport)?)
                    .bearer_auth(token)
                    .header("x-api-version", "13")
                    .header("x-vercel-blob-store-id", store)
                    .json(&json!({"urls":[format!("forge/{reference}")]}))
                    .send()
                    .await
                    .map_err(|_| UploadError::Transport)?;
                if response.status().is_success() {
                    Ok(())
                } else {
                    Err(UploadError::Transport)
                }
            }
        }
    }
}
#[async_trait]
impl delivery::Blobs for Storage {
    async fn get(
        &self,
        reference: &str,
        max: usize,
        timeout_ms: u64,
    ) -> Result<Option<Vec<u8>>, DeliveryError> {
        use upload::Transport;
        if max > files::MAX_BYTES {
            return Err(DeliveryError::Unavailable);
        }
        let read = async {
            let Some(mut reader) = self
                .read(reference)
                .await
                .map_err(|_| DeliveryError::Unavailable)?
            else {
                return Ok(None);
            };
            let mut bytes = Vec::new();
            while let Some(chunk) = reader
                .next()
                .await
                .map_err(|_| DeliveryError::Unavailable)?
            {
                if chunk.len() > max.saturating_sub(bytes.len()) {
                    let _ = reader.cancel().await;
                    return Err(DeliveryError::Unavailable);
                }
                bytes.extend_from_slice(&chunk);
            }
            let _ = reader.cancel().await;
            Ok(Some(bytes))
        };
        tokio::time::timeout(Duration::from_millis(timeout_ms), read)
            .await
            .map_err(|_| DeliveryError::Unavailable)?
    }
}
pub struct Inspector;
#[async_trait]
impl forge_core::agents::files::Blobs for Storage {
    async fn put(&self, reference: &str, bytes: Vec<u8>) -> Result<(), UploadError> {
        Storage::put(self, reference, bytes).await
    }
    async fn get(&self, reference: &str, max_bytes: usize) -> Result<Option<Vec<u8>>, UploadError> {
        delivery::Blobs::get(self, reference, max_bytes, 30_000)
            .await
            .map_err(|_| UploadError::Transport)
    }
    async fn delete(&self, reference: &str) -> Result<(), UploadError> {
        upload::Transport::delete(self, reference).await
    }
}
#[async_trait]
impl upload::Inspector for Inspector {
    async fn detect(&self, head: &[u8]) -> Result<Option<String>, UploadError> {
        let mut head = head;
        let mut skipped = 0;
        while let Some(rest) = head.strip_prefix(&[0xef, 0xbb, 0xbf]) {
            if skipped == 256 {
                return Ok(None);
            }
            skipped += 1;
            head = rest;
        }
        if head.starts_with(b"<?xml ")
            || head.starts_with(b"\xff\xfe<\0?\0x\0m\0l\0 \0")
            || head.starts_with(b"\xfe\xff\0<\0?\0x\0m\0l\0 ")
        {
            return Ok(Some("application/xml".into()));
        }
        if head.starts_with(b"\x89PNG") {
            return Ok(png(head).map(str::to_owned));
        }
        // The reference recognizes binary signatures, not generic HTML or shell
        // text. Text classification belongs to the streaming UTF-8 verifier.
        let detected = infer::get(head)
            .filter(|t| t.matcher_type() != infer::MatcherType::Text)
            .map(|t| t.mime_type().to_owned());
        if detected.as_deref() == Some("image/webp") && !head.starts_with(b"RIFF") {
            return Ok(None);
        }
        Ok(detected)
    }
}

// file-type probes PNG chunk headers before accepting the signature; retain its
// truncated-file fallback and APNG distinction instead of trusting four bytes.
fn png(head: &[u8]) -> Option<&'static str> {
    if !head.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    let mut offset = 8usize;
    let mut seen = false;
    for _ in 0..512 {
        let chunk = head.get(offset..offset + 8)?;
        let len = i32::from_be_bytes(chunk[..4].try_into().ok()?);
        if len < 0 {
            return None;
        }
        let kind = &chunk[4..8];
        if kind == b"IHDR" {
            if len != 13 {
                return None;
            }
            seen = true;
        }
        match kind {
            b"IDAT" => return Some("image/png"),
            b"acTL" => return Some("image/apng"),
            _ => {}
        }
        if !seen && kind != b"CgBI" {
            return None;
        }
        offset = offset.checked_add(12 + len as usize)?;
        if offset.saturating_add(8) >= head.len() {
            break;
        }
    }
    Some("image/png")
}
