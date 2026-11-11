//! First-party file HTTP transport. Metadata requests are capped independently of bytes.
pub mod render;
pub mod storage;
use crate::{auth, state::AppState};
use axum::{
    Json,
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use forge_core::{
    actor::{Actor, Authentication},
    files::{
        self, DeliveryError, UploadError, delivery,
        upload::{self},
    },
};
use serde_json::{Value, json};
use std::sync::Arc;
use storage::{Inspector, Storage};
pub struct Services {
    pub upload: upload::Service,
    pub delivery: delivery::Service,
    pub storage: Storage,
}
impl Services {
    pub fn new(database: forge_store::Database, storage: Storage, secret: String) -> Self {
        Self {
            upload: upload::Service {
                store: Arc::new(forge_store::files::UploadStore::new(database.clone())),
                transport: Arc::new(storage.clone()),
                inspector: Arc::new(Inspector),
            },
            delivery: delivery::Service {
                lookup: Arc::new(forge_store::files::FileLookup(database)),
                blobs: Arc::new(storage.clone()),
                secret,
                now: Arc::new(|| chrono::Utc::now().timestamp()),
            },
            storage,
        }
    }
}
fn h<'a>(headers: &'a HeaderMap, key: &str) -> &'a str {
    headers.get(key).and_then(|v| v.to_str().ok()).unwrap_or("")
}
fn upload_json(value: Value, status: u16) -> Response {
    (
        StatusCode::from_u16(status).unwrap(),
        [("cache-control", "no-store")],
        Json(value),
    )
        .into_response()
}
fn delivery_json(value: Value, status: u16) -> Response {
    (
        StatusCode::from_u16(status).unwrap(),
        render::headers(),
        Json(value),
    )
        .into_response()
}
fn upload_failure(e: UploadError) -> Response {
    let status = match e {
        UploadError::Unauthenticated => 401,
        UploadError::Access(_) => 403,
        UploadError::Conflict(_) | UploadError::Unavailable(_) => 409,
        UploadError::Limit { .. } => 429,
        UploadError::Transport => 503,
        _ => 400,
    };
    let mut r = upload_json(
        json!({"error":{"code":e.code(),"message":e.to_string()}}),
        status,
    );
    if let UploadError::Limit {
        retry_after_seconds: Some(seconds),
        ..
    } = e
    {
        r.headers_mut()
            .insert("retry-after", seconds.to_string().parse().unwrap());
    }
    r
}
fn delivery_failure(e: DeliveryError) -> Response {
    let status = match e {
        DeliveryError::Unauthenticated => 401,
        DeliveryError::InvalidGrant => 403,
        DeliveryError::NotFound => 404,
        DeliveryError::PreviewUnavailable => 415,
        DeliveryError::Unavailable => 503,
    };
    delivery_json(
        json!({"error":{"code":e.code(),"message":e.to_string()}}),
        status,
    )
}
async fn actor(state: &AppState, headers: &HeaderMap) -> Result<Actor, UploadError> {
    let (db, settings) = auth::configuration(state).map_err(|_| UploadError::Transport)?;
    let token = auth::cookie_token(headers, settings).map_err(|_| UploadError::Unauthenticated)?;
    forge_store::authority::session_actor(db, &token)
        .await
        .map_err(|e| match e {
            forge_store::StoreError::Unauthenticated => UploadError::Unauthenticated,
            forge_store::StoreError::EmailNotVerified => {
                UploadError::Access("Verify your email address before using Forge.")
            }
            forge_store::StoreError::Forbidden | forge_store::StoreError::NoActiveWorkspace => {
                UploadError::Access("Select a workspace you can access before uploading files.")
            }
            _ => UploadError::Transport,
        })
}
async fn metadata(body: Body) -> Result<Value, UploadError> {
    let bytes = axum::body::to_bytes(body, 8192).await.map_err(|_| {
        UploadError::Invalid(
            "Upload metadata cannot exceed 8192 bytes. Send file bytes directly to storage.",
        )
    })?;
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    forge_core::json::parse(text).map_err(|_| UploadError::Invalid("Invalid upload metadata JSON."))
}
pub(crate) async fn handle(State(state): State<AppState>, request: Request) -> Response {
    if request.uri().path().starts_with("/api/files/uploads") {
        match uploads(&state, request).await {
            Ok(r) => r,
            Err(e) => upload_failure(e),
        }
    } else {
        match deliver(&state, request).await {
            Ok(r) => r,
            Err(e) => delivery_failure(e),
        }
    }
}
async fn uploads(state: &AppState, request: Request) -> Result<Response, UploadError> {
    let settings = state.auth.as_ref().ok_or(UploadError::Transport)?;
    let origin = h(request.headers(), "origin");
    if request.headers().get_all("origin").iter().count() != 1
        || url::Url::parse(origin)
            .ok()
            .is_none_or(|v| v.origin() != settings.base_url.origin())
    {
        return Err(UploadError::Access("The request origin is not allowed."));
    }
    let a = actor(state, request.headers()).await?;
    let session = h(request.headers(), "x-forge-upload-session");
    let workspace = h(request.headers(), "x-forge-upload-workspace");
    if (!session.is_empty() || !workspace.is_empty())
        && (workspace != a.workspace_id
            || !matches!(&a.authentication,Authentication::Session{session_id} if !session.is_empty()&&session_id==session))
    {
        return Err(UploadError::Access(
            "The active session changed. Start the upload again.",
        ));
    }
    let path = request
        .uri()
        .path()
        .strip_suffix('/')
        .unwrap_or(request.uri().path())
        .to_owned();
    let parts: Vec<_> = path.split('/').collect();
    let not_found = || {
        upload_json(
            json!({"error":{"code":"NOT_FOUND","message":"Upload route not found."}}),
            404,
        )
    };
    if !matches!(*request.method(), Method::POST | Method::PUT) {
        return Ok(not_found());
    }
    let services = state.files.as_ref().ok_or(UploadError::Transport)?;
    if path == "/api/files/uploads" && request.method() == Method::POST {
        let result = services
            .upload
            .create(&a, metadata(request.into_body()).await?)
            .await?;
        return Ok(upload_json(result, 201));
    }
    if parts.len() != 6
        || parts[3] != "uploads"
        || !parts[4]
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c) || c == b'-')
        || !matches!(parts[5], "token" | "finalize" | "cancel" | "bytes")
    {
        return Ok(not_found());
    }
    let id = parts[4];
    if !forge_core::text::is_uuid(id) {
        return Err(UploadError::Invalid("Invalid upload metadata."));
    }
    if parts[5] == "bytes" && request.method() == Method::PUT {
        let intent = services.upload.store.prepare(&a, id, false).await?;
        services
            .storage
            .write_local(&intent, request.into_body())
            .await?;
        return Ok(upload_json(json!({"ok":true}), 200));
    }
    if request.method() != Method::POST {
        return Ok(not_found());
    }
    // HTTP bodies have no browser Request.body null marker; an empty body is absent.
    use axum::body::HttpBody;
    let body = request.into_body();
    if !body.is_end_stream() {
        let v = metadata(body).await?;
        if !v.as_object().is_some_and(|o| o.is_empty()) {
            return Err(UploadError::Invalid("Invalid upload metadata."));
        }
    }
    let result = match parts[5] {
        "token" => services.upload.token(&a, id).await?,
        "finalize" => services.upload.finalize(&a, id).await?,
        "cancel" => services.upload.cancel(&a, id).await?,
        _ => return Ok(not_found()),
    };
    Ok(upload_json(result, 200))
}
async fn deliver(state: &AppState, request: Request) -> Result<Response, DeliveryError> {
    let path = request.uri().path().to_owned();
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 6
        || !matches!(parts[3], "resources" | "artifacts" | "attachments")
        || !matches!(parts[5], "grant" | "download" | "preview")
        || (if parts[5] == "grant" {
            request.method() != Method::POST
        } else {
            request.method() != Method::GET
        })
    {
        return Ok(delivery_json(json!({"error":{"code":"NOT_FOUND"}}), 404));
    }
    let settings = state.auth.as_ref().ok_or(DeliveryError::Unavailable)?;
    let expected = settings.base_url.origin().ascii_serialization();
    let origin = h(request.headers(), "origin");
    if (!origin.is_empty() && origin != expected)
        || h(request.headers(), "sec-fetch-site") == "cross-site"
        || (parts[5] == "grant" && origin != expected)
        || request.headers().get_all("origin").iter().count() > 1
    {
        return Err(DeliveryError::NotFound);
    }
    let a = actor(state, request.headers()).await.map_err(|e| match e {
        UploadError::Unauthenticated => DeliveryError::Unauthenticated,
        UploadError::Access(_) => DeliveryError::NotFound,
        _ => DeliveryError::Unavailable,
    })?;
    let invalid = || delivery_json(json!({"error":{"code":"INVALID_REQUEST"}}), 400);
    let target = json!({"kind":parts[3],"id":parts[4]});
    if files::delivery_target(target.clone()).is_err() {
        return Ok(invalid());
    }
    let services = state.files.as_ref().ok_or(DeliveryError::Unavailable)?;
    if parts[5] == "grant" {
        let Ok(input) = metadata(request.into_body()).await else {
            return Ok(invalid());
        };
        if !input.as_object().is_some_and(|o| o.len() == 1)
            || !matches!(input["purpose"].as_str(), Some("download" | "preview"))
        {
            return Ok(invalid());
        }
        if services.delivery.secret.encode_utf16().count() < 32 {
            return Err(DeliveryError::Unavailable);
        }
        return Ok(delivery_json(
            services
                .delivery
                .grant(&a, &target, input["purpose"].as_str().unwrap())
                .await?,
            200,
        ));
    }
    let token = url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    if !(20..=2048).contains(&token.chars().count()) {
        return Ok(invalid());
    }
    let (file, content) = services
        .delivery
        .read(&a, &target, parts[5], &token)
        .await?;
    if parts[5] == "download" {
        render::download(&file, content)
    } else {
        render::preview(&file, &content)
    }
}
