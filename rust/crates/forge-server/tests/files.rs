use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    response::IntoResponse,
    routing::any,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{Duration, Utc};
use forge_core::files::{
    self,
    delivery::{Blobs, File},
    upload::{self, Inspector as _, Transport},
};
use forge_server::files::{
    render,
    storage::{Inspector, Storage, configuration},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use uuid::Uuid;
fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../reference-fixtures.json")).unwrap()
}
#[tokio::test]
async fn avatar_decoding_and_real_signature_validation_match_owning_source() {
    for case in fixture()["profiles"]["avatars"].as_array().unwrap() {
        let mut image = case["image"].as_str().unwrap().to_owned();
        if let Some(size) = case["resize"].as_u64() {
            let (prefix, content) = image.split_once(',').unwrap();
            let mut bytes = STANDARD.decode(content).unwrap();
            bytes.resize(size as usize, 0);
            image = format!("{prefix},{}", STANDARD.encode(bytes));
        }
        let result = forge_core::profiles::validate_avatar(&image, &Inspector).await;
        assert_eq!(
            result.err().map(|e| e.to_string()),
            case["error"].as_str().map(str::to_owned),
            "{case}"
        );
    }
}
fn intent(reference: &str, size: usize) -> upload::Intent {
    upload::Intent {
        id: Uuid::new_v4().to_string(),
        workspace_id: "workspace".into(),
        user_id: "user".into(),
        input: json!({"sizeBytes":size}),
        storage_reference: reference.into(),
        state: "pending".into(),
        expires_at: Utc::now() + Duration::days(1),
        token_expires_at: Some(Utc::now() + Duration::minutes(10)),
        result: None,
    }
}
fn file(name: &str, mime: &str) -> File {
    File {
        id: Uuid::new_v4().to_string(),
        name: name.into(),
        content_type: mime.into(),
        size_bytes: 1,
        checksum: files::checksum(b"x"),
        storage_reference: format!("files/{}", Uuid::new_v4()),
    }
}
struct Directory(std::path::PathBuf);
impl Directory {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("forge-files-{}", Uuid::new_v4())))
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[tokio::test]
async fn file_storage_configuration_tokens_and_detection_match_reference() {
    let cases = &fixture()["fileDelivery"];
    for case in cases["storage"].as_array().unwrap() {
        let env: HashMap<String, String> = serde_json::from_value(case["input"].clone()).unwrap();
        let r = configuration(&env);
        assert_eq!(r.is_ok(), case["valid"].as_bool().unwrap(), "{case}");
        if let Ok(adapter) = r {
            assert_eq!(adapter, case["adapter"]);
        }
    }
    for case in cases["tokens"].as_array().unwrap() {
        let storage = Storage::private(
            case["secret"].as_str().unwrap().into(),
            case["store"].as_str().unwrap().into(),
            "http://127.0.0.1:1/api/".parse().unwrap(),
            "http://127.0.0.1:1/".parse().unwrap(),
        )
        .unwrap();
        let mut i = intent(
            case["reference"].as_str().unwrap(),
            case["sizeBytes"].as_u64().unwrap() as usize,
        );
        i.token_expires_at =
            chrono::DateTime::from_timestamp_millis(case["validUntil"].as_i64().unwrap());
        assert_eq!(storage.grant(&i).await.unwrap()["token"], case["token"]);
    }
    for case in cases["detection"].as_array().unwrap() {
        let bytes = STANDARD.decode(case["bytes"].as_str().unwrap()).unwrap();
        assert_eq!(
            json!(Inspector.detect(&bytes).await.unwrap()),
            case["detected"],
            "{case}"
        );
    }
}
#[tokio::test]
async fn file_preview_and_download_responses_match_reference_and_legacy_filename_rules() {
    for (index, case) in fixture()["fileDelivery"]["rendering"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let f = file(
            case["name"].as_str().unwrap(),
            case["contentType"].as_str().unwrap(),
        );
        let bytes = STANDARD.decode(case["bytes"].as_str().unwrap()).unwrap();
        let result = if case["purpose"] == "preview" {
            render::preview(&f, &bytes)
        } else {
            render::download(&f, bytes)
        };
        if let Some(error) = case["error"].as_str() {
            assert_eq!(result.err().unwrap().code(), error, "case {index}");
            continue;
        }
        let response = result.unwrap();
        let headers: HashMap<String, String> = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_owned()))
            .collect();
        assert_eq!(json!(headers), case["headers"], "headers {index}");
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let expected = STANDARD.decode(case["body"].as_str().unwrap()).unwrap();
        assert_eq!(
            body.as_ref(),
            expected,
            "body {index}: {}",
            String::from_utf8_lossy(&body)
        );
    }
}
#[tokio::test]
async fn local_storage_has_bounded_reads_exclusive_writes_and_recoverable_cancelled_uploads() {
    let dir = Directory::new();
    let storage = Storage::local(&dir.0).unwrap();
    let agent_key = format!("attachments/{}", Uuid::new_v4());
    forge_core::agents::files::Blobs::put(&storage, &agent_key, Vec::new())
        .await
        .unwrap();
    assert_eq!(
        forge_core::agents::files::Blobs::get(&storage, &agent_key, 0)
            .await
            .unwrap(),
        Some(Vec::new())
    );
    assert!(
        forge_core::agents::files::Blobs::put(&storage, &agent_key, vec![1])
            .await
            .is_err()
    );
    forge_core::agents::files::Blobs::delete(&storage, &agent_key)
        .await
        .unwrap();
    assert!(
        forge_core::agents::files::Blobs::get(&storage, &agent_key, 0)
            .await
            .unwrap()
            .is_none()
    );
    let key = format!("files/{}", Uuid::new_v4());
    assert!(storage.get(&key, 5, 1000).await.unwrap().is_none());
    storage.put(&key, b"hello".to_vec()).await.unwrap();
    assert!(storage.put(&key, b"world".to_vec()).await.is_err());
    assert_eq!(storage.get(&key, 5, 1000).await.unwrap().unwrap(), b"hello");
    assert!(storage.get(&key, 4, 1000).await.is_err());
    for key in ["../other", "files/../outside", "https://evil.test/private"] {
        assert!(storage.get(key, 10, 1000).await.is_err());
        assert!(storage.put(key, b"x".to_vec()).await.is_err());
        assert!(storage.delete(key).await.is_err());
    }
    storage.delete(&key).await.unwrap();
    storage.delete(&key).await.unwrap();
    let i = intent(&key, 5);
    assert!(
        storage
            .write_local(&i, Body::from("too long"))
            .await
            .is_err()
    );
    for _ in 0..100 {
        if !dir.0.join(&key).exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    assert!(!dir.0.join(&key).exists());
    storage.write_local(&i, Body::from("hello")).await.unwrap();
    assert_eq!(storage.get(&key, 5, 1000).await.unwrap().unwrap(), b"hello");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(dir.0.join(&key))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    let cancel_key = format!("files/{}", Uuid::new_v4());
    let i = intent(&cancel_key, 5);
    let cloned = storage.clone();
    let (sent, recv) = tokio::sync::oneshot::channel();
    let stream = futures_util::stream::once(async move {
        let _ = sent.send(());
        Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"x"))
    })
    .chain(futures_util::stream::pending());
    use futures_util::StreamExt;
    let task = tokio::spawn(async move { cloned.write_local(&i, Body::from_stream(stream)).await });
    recv.await.unwrap();
    task.abort();
    let _ = task.await;
    for _ in 0..100 {
        if !dir.0.join(&cancel_key).exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    assert!(!dir.0.join(&cancel_key).exists());
}
type ProviderRequest = (String, String, axum::http::HeaderMap, Vec<u8>);
#[derive(Default)]
struct Provider {
    requests: Mutex<Vec<ProviderRequest>>,
    mode: std::sync::atomic::AtomicU8,
}
async fn provider(
    axum::extract::State(state): axum::extract::State<Arc<Provider>>,
    request: Request<Body>,
) -> axum::response::Response {
    let method = request.method().to_string();
    let uri = request.uri().to_string();
    let headers = request.headers().clone();
    let bytes = axum::body::to_bytes(request.into_body(), 1000)
        .await
        .unwrap();
    state
        .requests
        .lock()
        .unwrap()
        .push((method.clone(), uri, headers, bytes.to_vec()));
    match state.mode.load(std::sync::atomic::Ordering::SeqCst) {
        1 => (
            StatusCode::TEMPORARY_REDIRECT,
            [("location", "http://127.0.0.1:1/leak")],
            "secret-provider-message",
        )
            .into_response(),
        2 => StatusCode::NOT_FOUND.into_response(),
        3 => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        4 => Body::from_stream(futures_util::stream::pending::<
            Result<axum::body::Bytes, std::io::Error>,
        >())
        .into_response(),
        _ => {
            if method == "GET" {
                Body::from("hello").into_response()
            } else {
                JsonResponse.into_response()
            }
        }
    }
}
struct JsonResponse;
impl IntoResponse for JsonResponse {
    fn into_response(self) -> axum::response::Response {
        axum::Json(json!({"ok":true})).into_response()
    }
}
#[tokio::test]
async fn private_storage_uses_exact_provider_paths_no_cache_and_redacts_failed_or_redirected_reads()
{
    let state = Arc::new(Provider::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}/", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/{*path}", any(provider))
        .with_state(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let storage = Storage::private(
        "fixture-test-token".into(),
        "fixture".into(),
        format!("{origin}api/").parse().unwrap(),
        origin.parse().unwrap(),
    )
    .unwrap();
    let key = format!("files/{}", Uuid::new_v4());
    storage.put(&key, b"hello".to_vec()).await.unwrap();
    assert_eq!(storage.get(&key, 5, 1000).await.unwrap().unwrap(), b"hello");
    storage.delete(&key).await.unwrap();
    {
        let calls = state.requests.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].0, "PUT");
        assert!(calls[0].1.starts_with("/api/?pathname=forge%2Ffiles%2F"));
        assert_eq!(calls[0].2["x-vercel-blob-access"], "private");
        assert_eq!(calls[0].2["x-allow-overwrite"], "0");
        assert_eq!(calls[1].1, format!("/forge/{key}?cache=0"));
        assert_eq!(calls[1].2["authorization"], "Bearer fixture-test-token");
        assert_eq!(calls[2].1, "/api/delete");
        assert_eq!(
            serde_json::from_slice::<Value>(&calls[2].3).unwrap(),
            json!({"urls":[format!("forge/{key}")]})
        );
    }
    for mode in [1, 3, 4] {
        state.mode.store(mode, std::sync::atomic::Ordering::SeqCst);
        assert!(storage.get(&key, 5, 50).await.is_err());
    }
    state.mode.store(2, std::sync::atomic::Ordering::SeqCst);
    assert!(storage.get(&key, 5, 1000).await.unwrap().is_none());
    server.abort();
}
