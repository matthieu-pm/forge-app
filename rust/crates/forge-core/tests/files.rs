use async_trait::async_trait;
use chrono::{DateTime, Utc};
use forge_core::{
    actor::{Actor, Authentication},
    files::{self, DeliveryError, UploadError, delivery, upload},
};
use serde_json::{Value, json};
use std::{
    collections::{HashSet, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, AtomicUsize, Ordering},
    },
};
const ID: &str = "abcdefab-0000-4000-8000-000000000001";
fn actor() -> Actor {
    Actor {
        user_id: "user".into(),
        workspace_id: "workspace".into(),
        workspace_role: "member".into(),
        authentication: Authentication::Session {
            session_id: "session".into(),
        },
        scopes: None,
        loop_scope: None,
    }
}
fn now() -> DateTime<Utc> {
    "2026-01-01T00:00:00.000Z".parse().unwrap()
}
struct UploadState {
    intent: upload::Intent,
    chunks: Vec<Vec<u8>>,
    prepare_error: Option<UploadError>,
    publish_error: Option<UploadError>,
    read_error: Option<UploadError>,
    stream_error: Option<UploadError>,
    detected: Option<String>,
    missing: bool,
    rejected: Vec<String>,
    published: Vec<Value>,
    issued: Vec<bool>,
    cleanup: Vec<upload::Intent>,
    fail_delete: HashSet<String>,
    fail_clean: HashSet<String>,
    cleaned: Vec<String>,
    cleanup_limit: usize,
}
struct UploadFixture {
    state: Mutex<UploadState>,
    cancelled: Arc<AtomicUsize>,
    reads: AtomicUsize,
    grants: AtomicUsize,
}
impl UploadFixture {
    fn new(bytes: &[u8], kind: &str) -> Arc<Self> {
        let input = json!({"commandKey":ID,"target":{"kind":"agent"},"name":"File","contentType":kind,"sizeBytes":bytes.len(),"checksum":files::checksum(bytes)});
        let intent = upload::Intent {
            id: ID.into(),
            workspace_id: "workspace".into(),
            user_id: "user".into(),
            input,
            storage_reference: format!("files/{ID}"),
            state: "pending".into(),
            expires_at: now(),
            token_expires_at: Some(now()),
            result: None,
        };
        Arc::new(Self {
            state: Mutex::new(UploadState {
                intent: intent.clone(),
                chunks: bytes.chunks(3).map(Vec::from).collect(),
                prepare_error: None,
                publish_error: None,
                read_error: None,
                stream_error: None,
                detected: None,
                missing: false,
                rejected: vec![],
                published: vec![],
                issued: vec![],
                cleanup: vec![intent],
                fail_delete: HashSet::new(),
                fail_clean: HashSet::new(),
                cleaned: vec![],
                cleanup_limit: 0,
            }),
            cancelled: Arc::new(AtomicUsize::new(0)),
            reads: AtomicUsize::new(0),
            grants: AtomicUsize::new(0),
        })
    }
    fn service(self: &Arc<Self>) -> upload::Service {
        upload::Service {
            store: self.clone(),
            transport: self.clone(),
            inspector: self.clone(),
        }
    }
}
struct Reader {
    chunks: VecDeque<Vec<u8>>,
    cancelled: Arc<AtomicUsize>,
    error: Option<UploadError>,
}
#[async_trait]
impl upload::Reader for Reader {
    async fn next(&mut self) -> Result<Option<Vec<u8>>, UploadError> {
        if let Some(chunk) = self.chunks.pop_front() {
            Ok(Some(chunk))
        } else if let Some(error) = self.error.take() {
            Err(error)
        } else {
            Ok(None)
        }
    }
    async fn cancel(&mut self) -> Result<(), UploadError> {
        self.cancelled.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
#[async_trait]
impl upload::Store for UploadFixture {
    async fn create(&self, _: &Actor, input: Value) -> Result<upload::Intent, UploadError> {
        let mut i = self.state.lock().unwrap().intent.clone();
        i.input = input;
        Ok(i)
    }
    async fn prepare(
        &self,
        _: &Actor,
        _: &str,
        token: bool,
    ) -> Result<upload::Intent, UploadError> {
        let mut s = self.state.lock().unwrap();
        s.issued.push(token);
        if let Some(e) = &s.prepare_error {
            Err(e.clone())
        } else {
            Ok(s.intent.clone())
        }
    }
    async fn publish(&self, _: &Actor, _: &str, verified: Value) -> Result<Value, UploadError> {
        let mut s = self.state.lock().unwrap();
        if let Some(e) = &s.publish_error {
            return Err(e.clone());
        }
        s.published.push(verified.clone());
        Ok(verified)
    }
    async fn reject(&self, _: &Actor, _: &str, reason: &str) -> Result<(), UploadError> {
        self.state.lock().unwrap().rejected.push(reason.into());
        Ok(())
    }
    async fn cleanup_candidates(
        &self,
        _: DateTime<Utc>,
        limit: usize,
    ) -> Result<Vec<upload::Intent>, UploadError> {
        let mut s = self.state.lock().unwrap();
        s.cleanup_limit = limit;
        Ok(s.cleanup.clone())
    }
    async fn mark_cleaned(&self, id: &str) -> Result<(), UploadError> {
        let mut s = self.state.lock().unwrap();
        if s.fail_clean.contains(id) {
            return Err(UploadError::Transport);
        }
        s.cleaned.push(id.into());
        Ok(())
    }
}
#[async_trait]
impl upload::Transport for UploadFixture {
    async fn grant(&self, i: &upload::Intent) -> Result<Value, UploadError> {
        self.grants.fetch_add(1, Ordering::SeqCst);
        Ok(
            json!({"adapter":"local","url":"/bytes","maximumSizeInBytes":i.input["sizeBytes"],"validUntil":i.expires_at.timestamp_millis()}),
        )
    }
    async fn read(&self, _: &str) -> Result<Option<Box<dyn upload::Reader>>, UploadError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let s = self.state.lock().unwrap();
        if let Some(e) = &s.read_error {
            return Err(e.clone());
        }
        if s.missing {
            return Ok(None);
        }
        Ok(Some(Box::new(Reader {
            chunks: s.chunks.clone().into(),
            cancelled: self.cancelled.clone(),
            error: s.stream_error.clone(),
        })))
    }
    async fn delete(&self, reference: &str) -> Result<(), UploadError> {
        if self.state.lock().unwrap().fail_delete.contains(reference) {
            Err(UploadError::Transport)
        } else {
            Ok(())
        }
    }
}
#[async_trait]
impl upload::Inspector for UploadFixture {
    async fn detect(&self, _: &[u8]) -> Result<Option<String>, UploadError> {
        Ok(self.state.lock().unwrap().detected.clone())
    }
}
#[tokio::test]
async fn upload_verifies_streams_cancels_readers_and_publishes_only_metadata() {
    let bytes = "café😀".repeat(200_000).into_bytes();
    let f = UploadFixture::new(&bytes, "text/plain");
    let service = f.service();
    let result = service.finalize(&actor(), ID).await.unwrap();
    assert_eq!(result["checksum"], files::checksum(&bytes));
    assert_eq!(result["sizeBytes"], bytes.len());
    assert_eq!(result["contentType"], "text/plain");
    assert!(result.to_string().len() < 300);
    assert_eq!(f.cancelled.load(Ordering::SeqCst), 1);
    assert_eq!(f.state.lock().unwrap().published.len(), 1);
    {
        let mut s = f.state.lock().unwrap();
        s.intent.result = Some(result.clone());
    }
    assert_eq!(service.finalize(&actor(), ID).await.unwrap(), result);
    assert_eq!(f.reads.load(Ordering::SeqCst), 1);
    let token = service.token(&actor(), ID).await.unwrap();
    assert_eq!(token["state"], "ready");
    assert_eq!(f.grants.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn upload_failures_release_only_permanent_reservations_and_always_cancel_open_streams() {
    for kind in [
        "checksum", "oversize", "utf8", "json", "prepare", "publish", "read", "stream", "missing",
    ] {
        let f = UploadFixture::new(b"file", "text/plain");
        {
            let mut s = f.state.lock().unwrap();
            match kind {
                "checksum" => s.intent.input["checksum"] = json!("0".repeat(64)),
                "oversize" => s.intent.input["sizeBytes"] = json!(1),
                "utf8" => {
                    s.chunks = vec![vec![0xc3]];
                    s.intent.input["checksum"] = json!(files::checksum(&[0xc3]));
                    s.intent.input["sizeBytes"] = json!(1);
                }
                "json" => s.intent.input["contentType"] = json!("application/json"),
                "prepare" => s.prepare_error = Some(UploadError::Access("Membership revoked.")),
                "publish" => s.publish_error = Some(UploadError::Access("Upload type disabled.")),
                "read" => s.read_error = Some(UploadError::Transport),
                "stream" => s.stream_error = Some(UploadError::Transport),
                "missing" => s.missing = true,
                _ => unreachable!(),
            }
        }
        let result = f.service().finalize(&actor(), ID).await;
        if kind == "utf8" {
            assert_eq!(result.unwrap()["contentType"], "application/octet-stream");
            continue;
        }
        assert!(result.is_err(), "{kind}");
        let permanent = ["checksum", "oversize", "json", "prepare", "publish"].contains(&kind);
        assert_eq!(
            f.state.lock().unwrap().rejected.len(),
            usize::from(permanent),
            "{kind}"
        );
        assert!(f.state.lock().unwrap().published.is_empty(), "{kind}");
        assert_eq!(
            f.cancelled.load(Ordering::SeqCst),
            usize::from(!["prepare", "read", "missing"].contains(&kind)),
            "{kind}"
        );
    }
}
#[tokio::test]
async fn upload_tokens_cancel_and_cleanup_keep_ready_files_and_retain_failed_inventory() {
    let f = UploadFixture::new(b"file", "text/plain");
    let service = f.service();
    let token = service.token(&actor(), ID).await.unwrap();
    assert_eq!(token["state"], "pending");
    assert_eq!(f.state.lock().unwrap().issued, vec![true]);
    f.state.lock().unwrap().prepare_error = Some(UploadError::Access("No longer authorized."));
    assert!(service.token(&actor(), ID).await.is_err());
    assert_eq!(
        f.state.lock().unwrap().rejected,
        vec!["No longer authorized."]
    );
    service.cancel(&actor(), ID).await.unwrap();
    assert_eq!(
        f.state.lock().unwrap().rejected.last().unwrap(),
        "Upload cancelled."
    );
    {
        let mut s = f.state.lock().unwrap();
        for suffix in ["delete", "mark"] {
            let mut i = s.intent.clone();
            i.id = suffix.into();
            i.storage_reference = suffix.into();
            s.cleanup.push(i);
        }
        s.fail_delete.insert("delete".into());
        s.fail_clean.insert("mark".into());
    }
    let swept = service.sweep(now(), 9999).await.unwrap();
    assert_eq!(
        swept,
        json!({"examined":3,"deleted":1,"failures":["delete","mark"]})
    );
    assert_eq!(f.state.lock().unwrap().cleanup_limit, 1000);
    assert_eq!(f.state.lock().unwrap().cleaned, vec![ID]);
}
#[test]
fn verification_bounds_headers_and_accepts_json_syntax_without_numeric_conversion() {
    let text = format!("{}1e999{}", "[".repeat(20_000), "]".repeat(20_000));
    assert!(files::verification::json_valid(text.as_bytes()));
    assert!(files::verification::json_valid(br#""\ud800""#));
    assert!(!files::verification::json_valid(br#"{"a":1,}"#));
    let bytes = vec![b'x'; 2_000_000];
    let input = json!({"sizeBytes":bytes.len(),"checksum":files::checksum(&bytes),"contentType":"text/plain"});
    let mut v = files::verification::Verification::new(&input).unwrap();
    for chunk in bytes.chunks(65536) {
        v.push(chunk).unwrap();
    }
    let verified = v.finish().unwrap();
    assert_eq!(verified.head.len(), 1_048_576);
    assert!(verified.utf8_text);
}

struct DeliveryState {
    file: delivery::File,
    bytes: Vec<u8>,
    mode: &'static str,
    lookups: usize,
    reads: usize,
    revoked: bool,
}
struct DeliveryFixture {
    state: Mutex<DeliveryState>,
    clock: Arc<AtomicI64>,
}
impl DeliveryFixture {
    fn new() -> Arc<Self> {
        let bytes = b"Private file".to_vec();
        Arc::new(Self {
            state: Mutex::new(DeliveryState {
                file: delivery::File {
                    id: ID.into(),
                    name: "Private.txt".into(),
                    content_type: "text/plain".into(),
                    size_bytes: bytes.len(),
                    checksum: files::checksum(&bytes),
                    storage_reference: format!("files/{ID}"),
                },
                bytes,
                mode: "ok",
                lookups: 0,
                reads: 0,
                revoked: false,
            }),
            clock: Arc::new(AtomicI64::new(1700000000)),
        })
    }
    fn service(self: &Arc<Self>) -> delivery::Service {
        let clock = self.clock.clone();
        delivery::Service {
            lookup: self.clone(),
            blobs: self.clone(),
            secret: "reference-file-grant-key-not-for-production".into(),
            now: Arc::new(move || clock.load(Ordering::SeqCst)),
        }
    }
}
#[async_trait]
impl delivery::Lookup for DeliveryFixture {
    async fn lookup(&self, _: &Actor, _: &Value) -> Result<Option<delivery::File>, DeliveryError> {
        let mut s = self.state.lock().unwrap();
        s.lookups += 1;
        Ok((!s.revoked).then(|| s.file.clone()))
    }
}
#[async_trait]
impl delivery::Blobs for DeliveryFixture {
    async fn get(
        &self,
        _: &str,
        max_bytes: usize,
        timeout: u64,
    ) -> Result<Option<Vec<u8>>, DeliveryError> {
        let mut s = self.state.lock().unwrap();
        s.reads += 1;
        assert_eq!(timeout, 30_000);
        assert_eq!(max_bytes, s.file.size_bytes);
        match s.mode {
            "missing" => return Ok(None),
            "outage" => return Err(DeliveryError::Unavailable),
            "revoke" => s.revoked = true,
            "replace" => s.file.storage_reference = "files/replaced".into(),
            "expire" => {
                self.clock.fetch_add(301, Ordering::SeqCst);
            }
            "corrupt" => return Ok(Some(b"Corrupt file".to_vec())),
            _ => {}
        }
        Ok(Some(s.bytes.clone()))
    }
}
#[tokio::test]
async fn file_delivery_grants_hide_storage_and_recheck_authority_integrity_and_expiry_after_io() {
    let target = json!({"kind":"resources","id":ID});
    for mode in [
        "ok", "missing", "outage", "revoke", "replace", "expire", "corrupt",
    ] {
        let f = DeliveryFixture::new();
        f.state.lock().unwrap().mode = mode;
        let service = f.service();
        let grant = service.grant(&actor(), &target, "download").await.unwrap();
        assert!(grant["file"].get("checksum").is_none());
        assert!(!grant.to_string().contains("storageReference"));
        let token = grant["url"]
            .as_str()
            .unwrap()
            .split("?token=")
            .nth(1)
            .unwrap();
        let result = service.read(&actor(), &target, "download", token).await;
        if mode == "ok" {
            assert_eq!(result.unwrap().1, b"Private file");
            assert_eq!(f.state.lock().unwrap().lookups, 3);
        } else {
            let expected = match mode {
                "revoke" => DeliveryError::NotFound,
                "expire" => DeliveryError::InvalidGrant,
                _ => DeliveryError::Unavailable,
            };
            assert_eq!(result.unwrap_err(), expected, "{mode}");
        }
    }
}
#[tokio::test]
async fn delivery_denies_other_accounts_scoped_actors_and_oversized_previews_before_storage_io() {
    let f = DeliveryFixture::new();
    let service = f.service();
    let target = json!({"kind":"attachments","id":ID});
    let grant = service.grant(&actor(), &target, "preview").await.unwrap();
    let token = grant["url"]
        .as_str()
        .unwrap()
        .split("?token=")
        .nth(1)
        .unwrap();
    let mut other = actor();
    other.user_id = "other".into();
    assert_eq!(
        service
            .read(&other, &target, "preview", token)
            .await
            .unwrap_err(),
        DeliveryError::InvalidGrant
    );
    assert_eq!(f.state.lock().unwrap().reads, 0);
    other = actor();
    other.scopes = Some(vec![]);
    assert_eq!(
        service.grant(&other, &target, "preview").await.unwrap_err(),
        DeliveryError::NotFound
    );
    f.state.lock().unwrap().file.size_bytes = files::PREVIEW_MAX_BYTES + 1;
    assert_eq!(
        service
            .grant(&actor(), &target, "preview")
            .await
            .unwrap_err(),
        DeliveryError::PreviewUnavailable
    );
    assert_eq!(f.state.lock().unwrap().reads, 0);
}
