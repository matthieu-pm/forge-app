//! Native run protocol. These endpoints use Forge's signed service channel;
//! they are not the public browser API and do not accept user session cookies.
use crate::{
    auth::Channel,
    engine::{Decision, Phase, State as EngineState},
    host::Host,
    journal::Session,
};
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use forge_core::canonical::javascript_stringify;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::VecDeque, convert::Infallible, sync::Arc, time::Duration};
use tokio::time::{sleep, timeout};
use uuid::Uuid;

#[derive(Clone)]
struct Service {
    host: Host,
    secret: Arc<str>,
}
#[derive(Clone, Copy)]
struct Failure(StatusCode, &'static str);
const BAD: Failure = Failure(StatusCode::BAD_REQUEST, "Invalid native runtime request.");
const AUTH: Failure = Failure(StatusCode::UNAUTHORIZED, "Unauthorized runtime request.");
const MISSING: Failure = Failure(
    StatusCode::NOT_FOUND,
    "The native runtime run is unavailable.",
);
const CONFLICT: Failure = Failure(
    StatusCode::CONFLICT,
    "The native runtime request conflicts with the saved run.",
);
const UNAVAILABLE: Failure = Failure(
    StatusCode::SERVICE_UNAVAILABLE,
    "The native runtime is temporarily unavailable. Retry the same request.",
);
impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"ok":false,"message":self.1}))).into_response()
    }
}
type HttpResult<T> = std::result::Result<T, Failure>;
impl Service {
    fn channel(&self, headers: &HeaderMap, run: &str) -> HttpResult<Channel> {
        if headers.get_all(header::AUTHORIZATION).iter().count() != 1 {
            return Err(AUTH);
        }
        let token = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or(AUTH)?;
        let channel =
            Channel::verify(&self.secret, token, Utc::now().timestamp()).map_err(|_| AUTH)?;
        if channel
            .expires_at()
            .is_none_or(|at| at <= Utc::now().timestamp_millis() as f64 / 1000.)
        {
            return Err(AUTH);
        }
        if channel.run_id() != run || Uuid::parse_str(run).is_err() {
            return Err(MISSING);
        }
        Ok(channel)
    }
    async fn load(&self, channel: &Channel) -> HttpResult<Session> {
        timeout(Duration::from_secs(5), self.host.store().load(channel))
            .await
            .map_err(|_| UNAVAILABLE)?
            .map_err(|_| MISSING)
    }
}
pub fn router(host: Host, secret: String) -> crate::Result<Router> {
    if secret.encode_utf16().count() < 32 {
        return Err(crate::Error("The runtime channel secret is invalid."));
    }
    let service = Service {
        host,
        secret: secret.into(),
    };
    Ok(Router::new()
        .route(
            "/health",
            get(|| async { Json(json!({"ok":true,"service":"forge-native-runtime"})) }),
        )
        .route(
            "/ready",
            get(|| async {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"ok":false,"reason":"rewrite-not-qualified"})),
                )
            }),
        )
        .route("/native/v1/runs/{run}", post(admit).get(status))
        .route("/native/v1/runs/{run}/resume", post(resume))
        .route("/native/v1/runs/{run}/recover", post(recover))
        .route("/native/v1/runs/{run}/cancel", post(cancel))
        .route("/native/v1/runs/{run}/events", get(events))
        .route("/native/v1/runs/{run}/stream", get(stream))
        .layer(DefaultBodyLimit::max(4 * 1024 * 1024))
        .layer(axum::middleware::from_fn(
            |request: axum::extract::Request, next: axum::middleware::Next| async move {
                timeout(Duration::from_secs(10), next.run(request))
                    .await
                    .unwrap_or_else(|_| UNAVAILABLE.into_response())
            },
        ))
        .layer(axum::middleware::map_response(
            |mut response: Response| async move {
                response
                    .headers_mut()
                    .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
                response
                    .headers_mut()
                    .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
                response
            },
        ))
        .with_state(service))
}
fn parse<T: serde::de::DeserializeOwned>(headers: &HeaderMap, bytes: &[u8]) -> HttpResult<T> {
    if !headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .next()
                .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
        })
    {
        return Err(Failure(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "JSON content type is required.",
        ));
    }
    let value =
        forge_core::json::parse(std::str::from_utf8(bytes).map_err(|_| BAD)?).map_err(|_| BAD)?;
    serde_json::from_value(value).map_err(|_| BAD)
}
fn public(session: &Session) -> Value {
    json!({"phase":session.state.phase(),"cancelled":session.cancelled,"nextIndex":session.next_index,"deadline":session.deadline.timestamp_millis(),"pendingRequestId":session.state.pending_request(),"workerActive":session.worker_active})
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Admission {
    message: String,
    deadline: i64,
    #[serde(default)]
    conversation_id: Option<Uuid>,
    #[serde(default)]
    previous_run_id: Option<Uuid>,
    #[serde(default)]
    attachments: Vec<Attachment>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Attachment {
    name: String,
    content_type: String,
    content_base64: String,
}
impl Admission {
    fn message(&self) -> HttpResult<Value> {
        let text = forge_core::text::trim(&self.message);
        if text.is_empty()
            || text.chars().count() > 100_000
            || self.attachments.len() > 20
            || (self.previous_run_id.is_some() && self.conversation_id.is_none())
        {
            return Err(BAD);
        }
        let mut parts = vec![json!({"type":"text","text":text})];
        for file in &self.attachments {
            if file.name.is_empty()
                || file.name.chars().count() > 255
                || file.name.chars().any(char::is_control)
            {
                return Err(BAD);
            }
            forge_core::agents::files::decode_attachment(&file.content_base64).map_err(|_| BAD)?;
            parts.push(json!({"type":"file","data":{"type":"data","data":file.content_base64},"mediaType":file.content_type,"filename":file.name}));
        }
        Ok(json!({"role":"user","content":parts}))
    }
}
async fn admit(
    State(service): State<Service>,
    Path(run): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HttpResult<Response> {
    let channel = service.channel(&headers, &run)?;
    let input: Admission = parse(&headers, &body)?;
    let message = input.message()?;
    EngineState::new(&channel, vec![message.clone()]).map_err(|_| BAD)?;
    let deadline = DateTime::from_timestamp_millis(input.deadline).ok_or(BAD)?;
    // The trusted application supplies its original deadline. Repeating admission
    // cannot change it; expired requests may retrieve an existing identical run.
    if deadline > Utc::now() + chrono::Duration::minutes(15) {
        return Err(BAD);
    }
    if deadline <= Utc::now() && service.load(&channel).await.is_err() {
        return Err(BAD);
    }
    let admission = async {
        if let Some(conversation) = input.conversation_id {
            service
                .host
                .store()
                .admit(
                    &channel,
                    conversation,
                    input.previous_run_id,
                    message,
                    deadline,
                )
                .await
        } else {
            let state = EngineState::new(&channel, vec![message])?;
            service
                .host
                .store()
                .create(&channel, &state, deadline)
                .await
        }
    };
    let session = timeout(Duration::from_secs(5), admission)
        .await
        .map_err(|_| UNAVAILABLE)?
        .map_err(|_| CONFLICT)?;
    if !session.cancelled
        && !matches!(
            session.state.phase(),
            Phase::Complete | Phase::Failed | Phase::Waiting
        )
    {
        if session.deadline <= Utc::now() {
            return Err(CONFLICT);
        }
        service.host.kick(channel).map_err(|_| UNAVAILABLE)?;
    }
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"ok":true,"runId":run,"status":public(&session)})),
    )
        .into_response())
}
async fn status(
    State(service): State<Service>,
    Path(run): Path<String>,
    headers: HeaderMap,
) -> HttpResult<Json<Value>> {
    let channel = service.channel(&headers, &run)?;
    Ok(Json(
        json!({"ok":true,"status":public(&service.load(&channel).await?)}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Approval {
    request_id: String,
    approved: bool,
}
async fn resume(
    State(service): State<Service>,
    Path(run): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HttpResult<Response> {
    let channel = service.channel(&headers, &run)?;
    let input: Approval = parse(&headers, &body)?;
    if Uuid::parse_str(&input.request_id).is_err() {
        return Err(BAD);
    }
    timeout(
        Duration::from_secs(5),
        service.host.store().respond(
            &channel,
            &input.request_id,
            if input.approved {
                Decision::Approved
            } else {
                Decision::Denied
            },
        ),
    )
    .await
    .map_err(|_| UNAVAILABLE)?
    .map_err(|_| CONFLICT)?;
    // A 202 is returned only after persistence. Capacity/shutdown returns a 503;
    // the identical retry recognizes the receipt and can wake another worker.
    service.host.kick(channel).map_err(|_| UNAVAILABLE)?;
    Ok((StatusCode::ACCEPTED, Json(json!({"ok":true,"runId":run}))).into_response())
}
async fn recover(
    State(service): State<Service>,
    Path(run): Path<String>,
    headers: HeaderMap,
) -> HttpResult<Response> {
    let channel = service.channel(&headers, &run)?;
    let session = service.load(&channel).await?;
    if session.cancelled
        || (session.deadline <= Utc::now()
            && !matches!(session.state.phase(), Phase::Complete | Phase::Failed))
    {
        return Err(CONFLICT);
    }
    service.host.kick(channel).map_err(|_| UNAVAILABLE)?;
    Ok((StatusCode::ACCEPTED, Json(json!({"ok":true,"runId":run}))).into_response())
}
async fn cancel(
    State(service): State<Service>,
    Path(run): Path<String>,
    headers: HeaderMap,
) -> HttpResult<Json<Value>> {
    let channel = service.channel(&headers, &run)?;
    timeout(
        Duration::from_secs(5),
        service.host.store().cancel(&channel),
    )
    .await
    .map_err(|_| UNAVAILABLE)?
    .map_err(|_| MISSING)?;
    service.host.stop(&run);
    Ok(Json(json!({"ok":true,"runId":run})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    #[serde(default)]
    after: u64,
    #[serde(default = "page_size")]
    limit: usize,
}
fn page_size() -> usize {
    32
}
impl Page {
    fn validate(&self) -> HttpResult<()> {
        if self.after > i64::MAX as u64 || !(1..=64).contains(&self.limit) {
            Err(BAD)
        } else {
            Ok(())
        }
    }
}
async fn events(
    State(service): State<Service>,
    Path(run): Path<String>,
    headers: HeaderMap,
    Query(page): Query<Page>,
) -> HttpResult<Json<Value>> {
    let channel = service.channel(&headers, &run)?;
    page.validate()?;
    let session = service.load(&channel).await?;
    let events = timeout(
        Duration::from_secs(5),
        service
            .host
            .store()
            .events(&channel, page.after, page.limit),
    )
    .await
    .map_err(|_| UNAVAILABLE)?
    .map_err(|_| MISSING)?;
    let next = events.last().map_or(page.after, |e| e.index + 1);
    Ok(Json(
        json!({"ok":true,"events":events.into_iter().map(|e|json!({"index":e.index,"event":e.value})).collect::<Vec<_>>(),"nextIndex":next,"status":public(&session)}),
    ))
}
struct Reader {
    service: Service,
    channel: Channel,
    after: u64,
    limit: usize,
    pending: VecDeque<Value>,
    done: bool,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
impl Reader {
    async fn next(&mut self) -> Option<Value> {
        loop {
            if self.done {
                return None;
            }
            if self.service.host.is_stopping() {
                self.done = true;
                return Some(
                    json!({"error":{"code":"RUNTIME_SHUTTING_DOWN","message":"Reconnect to another runtime host."}}),
                );
            }
            if self
                .channel
                .expires_at()
                .is_none_or(|at| at <= Utc::now().timestamp_millis() as f64 / 1000.)
            {
                self.done = true;
                return Some(json!({"error":{"code":"UNAUTHORIZED","message":AUTH.1}}));
            }
            if let Some(event) = self.pending.pop_front() {
                return Some(event);
            }
            let loaded = async {
                let session = self.service.host.store().load(&self.channel).await?;
                let events = self
                    .service
                    .host
                    .store()
                    .events(&self.channel, self.after, self.limit)
                    .await?;
                Ok::<_, crate::Error>((session, events))
            };
            let Ok(Ok((session, events))) = timeout(Duration::from_secs(5), loaded).await else {
                self.done = true;
                return Some(
                    json!({"error":{"code":"RUNTIME_UNAVAILABLE","message":UNAVAILABLE.1}}),
                );
            };
            for event in events {
                self.after = event.index + 1;
                self.pending
                    .push_back(json!({"index":event.index,"event":event.value}));
            }
            if !self.pending.is_empty() {
                continue;
            }
            if session.cancelled
                || matches!(
                    session.state.phase(),
                    Phase::Waiting | Phase::Complete | Phase::Failed
                )
            {
                self.done = true;
                return Some(json!({"status":public(&session)}));
            }
            if session.deadline <= Utc::now() {
                self.done = true;
                return Some(
                    json!({"error":{"code":"RUN_WALL_CLOCK_LIMIT","message":"The agent run deadline has elapsed."}}),
                );
            }
            if !session.worker_active && !self.service.host.is_active(self.channel.run_id()) {
                self.done = true;
                return Some(
                    json!({"error":{"code":"RUNTIME_INTERRUPTED","message":"Reconnect with a fresh runtime credential to recover this run."}}),
                );
            }
            sleep(Duration::from_millis(200)).await;
        }
    }
}
async fn stream(
    State(service): State<Service>,
    Path(run): Path<String>,
    headers: HeaderMap,
    Query(page): Query<Page>,
) -> HttpResult<Response> {
    let channel = service.channel(&headers, &run)?;
    page.validate()?;
    service.load(&channel).await?;
    let permit = service.host.reader().map_err(|_| UNAVAILABLE)?;
    let reader = Reader {
        service,
        channel,
        after: page.after,
        limit: page.limit,
        pending: VecDeque::new(),
        done: false,
        _permit: permit,
    };
    let stream = futures_util::stream::unfold(reader, |mut reader| async move {
        let event = reader.next().await?;
        let text = javascript_stringify(&event) + "\n";
        Some((Ok::<_, Infallible>(Bytes::from(text)), reader))
    });
    Ok((
        [(header::CONTENT_TYPE, "application/x-ndjson")],
        Body::from_stream(stream),
    )
        .into_response())
}
