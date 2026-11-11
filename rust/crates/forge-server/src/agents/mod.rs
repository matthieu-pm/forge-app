//! First-party agent HTTP boundaries. Session routes never accept bearer-only
//! authority; local callbacks additionally require an exact run-scoped token.
use crate::{auth, state::AppState};
use axum::{
    Json,
    body::{Body, Bytes, to_bytes},
    extract::{Request, State},
    http::{HeaderMap, Method},
    response::{IntoResponse, Response},
};
use forge_core::{
    actor::{Actor, ApiScope, Authentication},
    agents::{
        contracts, policy,
        tokens::{self, Kind},
    },
};
use forge_store::{
    StoreError,
    agents::{
        capabilities::Gateway,
        coordinator::{RunSession, Service},
        model_connections,
    },
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{convert::Infallible, sync::Arc};
use uuid::Uuid;
mod errors;
use errors::*;

pub struct Settings {
    pub coordinator: Service,
    pub models: Arc<model_connections::Service>,
    pub capabilities: Gateway,
    pub features: Value,
    pub local_secret: String,
    pub artifact_secret: String,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}
impl Settings {
    pub fn new(coordinator: Service, models: Arc<model_connections::Service>) -> Self {
        let capabilities = Gateway::new(coordinator.database.clone());
        Self {
            coordinator,
            models,
            capabilities,
            features: policy::features(&Default::default()),
            local_secret: String::new(),
            artifact_secret: String::new(),
            now: Arc::new(|| chrono::Utc::now().timestamp()),
        }
    }
}
fn json_response(value: Value, status: u16) -> Response {
    (
        axum::http::StatusCode::from_u16(status).unwrap(),
        [
            ("cache-control", "no-store"),
            ("content-type", "application/json;charset=utf-8"),
        ],
        Json(value),
    )
        .into_response()
}
fn header<'a>(headers: &'a HeaderMap, key: &str) -> Option<&'a str> {
    if headers.get_all(key).iter().count() != 1 {
        return None;
    }
    headers.get(key)?.to_str().ok()
}
fn id(s: &str) -> Result<Uuid, Error> {
    if !forge_core::text::is_uuid(s) {
        return Err(invalid());
    }
    s.parse().map_err(|_| invalid())
}
fn query(uri: &axum::http::Uri, key: &str) -> Option<String> {
    url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}
fn after(value: &str) -> Result<i32, Error> {
    let value = forge_core::text::trim(value);
    let radix = if value.starts_with("0x") || value.starts_with("0X") {
        Some(16)
    } else if value.starts_with("0b") || value.starts_with("0B") {
        Some(2)
    } else if value.starts_with("0o") || value.starts_with("0O") {
        Some(8)
    } else {
        None
    };
    let n = if let Some(radix) = radix {
        u64::from_str_radix(&value[2..], radix).map_err(|_| invalid())? as f64
    } else if value.is_empty() {
        0.
    } else {
        value.parse::<f64>().map_err(|_| invalid())?
    };
    if !n.is_finite() || !(0. ..=9007199254740991.).contains(&n) || n.fract() != 0. {
        return Err(invalid());
    }
    Ok(n.min(i32::MAX as f64) as i32)
}
fn segments(path: &str) -> Result<Vec<String>, Error> {
    path.strip_prefix("/api/agent")
        .unwrap_or("")
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| {
            let mut out = Vec::new();
            let mut bytes = s.bytes();
            while let Some(b) = bytes.next() {
                out.push(if b == b'%' {
                    let a = bytes
                        .next()
                        .and_then(|b| (b as char).to_digit(16))
                        .ok_or_else(invalid)?;
                    let b = bytes
                        .next()
                        .and_then(|b| (b as char).to_digit(16))
                        .ok_or_else(invalid)?;
                    (a * 16 + b) as u8
                } else {
                    b
                });
            }
            String::from_utf8(out).map_err(|_| invalid())
        })
        .collect()
}
async fn body(request: Request) -> Result<Value, Error> {
    let bytes = to_bytes(request.into_body(), 16 * 1024 * 1024)
        .await
        .map_err(|_| {
            failure(
                413,
                "REQUEST_TOO_LARGE",
                "The agent request exceeds its size limit.",
            )
        })?;
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    forge_core::json::parse(text).map_err(|_| invalid())
}
fn local_token(
    settings: &Settings,
    headers: &HeaderMap,
    actor: &Actor,
    run: &str,
) -> Result<Value, Error> {
    let rejected = || {
        failure(
            401,
            "UNAUTHORIZED",
            "The run-scoped local ingest token is invalid or expired.",
        )
    };
    let token = header(headers, "authorization")
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| !s.is_empty() && !s.chars().any(char::is_whitespace))
        .ok_or_else(rejected)?;
    tokens::verify_local(
        &settings.local_secret,
        token,
        actor,
        run,
        None,
        (settings.now)(),
    )
    .map_err(|_| rejected())
}
fn stream(session: RunSession, actor: Actor, db: forge_store::Database) -> Response {
    let stream = futures_util::stream::unfold(
        (session.events, actor, db, false),
        |(mut events, actor, db, done)| async move {
            if done {
                return None;
            }
            let event = events.next().await?;
            let authorized = async {
                let mut tx = db.begin().await?;
                forge_store::authority::current_actor(&mut tx, &actor).await?;
                tx.commit().await
            }
            .await;
            let (text,done)=match (event,authorized){(Ok(event),Ok(()))=>(format!("id: {}\nevent: {}\ndata: {}\n\n",event.sequence,event.kind,forge_core::canonical::javascript_stringify(&json!(event))),false),_=>("event: transport.error\ndata: {\"code\":\"STREAM_FAILED\",\"message\":\"The event stream failed.\"}\n\n".into(),true)};
            Some((
                Ok::<_, Infallible>(Bytes::from(text)),
                (events, actor, db, done),
            ))
        },
    );
    (
        [
            ("cache-control", "no-cache, no-transform"),
            ("connection", "keep-alive"),
            ("content-type", "text/event-stream; charset=utf-8"),
            ("x-accel-buffering", "no"),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}
pub(crate) async fn handle(State(state): State<AppState>, request: Request) -> Response {
    match handle_inner(state, request).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}
async fn handle_inner(state: AppState, request: Request) -> Result<Response, Error> {
    let settings = state.agents.as_deref().ok_or_else(unavailable)?;
    let path = segments(request.uri().path())?;
    let parts: Vec<_> = path.iter().map(String::as_str).collect();
    if settings.features["agent_ui"] != true && parts != ["features"] {
        return Err(failure(
            404,
            "FEATURE_DISABLED",
            "Forge Agent is not enabled for this deployment.",
        ));
    }
    if matches!(
        parts.first(),
        Some(&"local-runs" | &"local-ingest" | &"local-tool-calls")
    ) && settings.features["agent_codex_local"] != true
    {
        return Err(failure(
            404,
            "FEATURE_DISABLED",
            "Local Codex execution is not enabled.",
        ));
    }
    if matches!(parts.first(), Some(&"models" | &"connections"))
        && settings.features["agent_model_connections"] != true
    {
        return Err(failure(
            404,
            "FEATURE_DISABLED",
            "Model connections are not enabled.",
        ));
    }
    let (db, auth) = auth::configuration(&state).map_err(|_| unavailable())?;
    if !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) && header(request.headers(), "origin")
        .and_then(|s| url::Url::parse(s).ok())
        .is_none_or(|url| url.origin() != auth.base_url.origin())
    {
        return Err(failure(
            403,
            "INVALID_ORIGIN",
            "The request origin is not allowed.",
        ));
    }
    let token = auth::cookie_token(request.headers(), auth).map_err(|_| unauthorized())?;
    let actor = forge_store::authority::session_actor(db, &token)
        .await
        .map_err(|e| {
            if matches!(e, StoreError::EmailNotVerified) {
                Error::from(e)
            } else {
                unauthorized()
            }
        })?;
    let c = &settings.coordinator;
    match (request.method().as_str(), parts.as_slice()) {
        ("GET", ["features"]) => Ok(json_response(settings.features.clone(), 200)),
        ("GET", ["threads"]) => Ok(json_response(json!(c.list_threads(&actor).await?), 200)),
        ("POST", ["threads"]) => Ok(json_response(
            json!(c.create_thread(&actor, body(request).await?).await?),
            201,
        )),
        ("PATCH", ["threads", thread]) => Ok(json_response(
            json!(
                c.mutate_thread(&actor, id(thread)?, body(request).await?)
                    .await?
            ),
            200,
        )),
        ("GET", ["threads", thread, "events"]) => Ok(json_response(
            json!(c.thread_events(&actor, id(thread)?).await?),
            200,
        )),
        ("GET", ["threads", thread, "preferences"]) => Ok(json_response(
            json!(c.get_preference(&actor, id(thread)?).await?),
            200,
        )),
        ("PUT", ["threads", thread, "preferences"]) => Ok(json_response(
            json!(
                c.set_preference(&actor, id(thread)?, body(request).await?)
                    .await?
            ),
            200,
        )),
        ("POST", ["runs"]) => {
            let correlation = header(request.headers(), "x-correlation-id").map(str::to_owned);
            Ok(stream(
                c.start_turn(&actor, body(request).await?, correlation)
                    .await?,
                actor,
                db.clone(),
            ))
        }
        ("GET", ["runs", run, "events"]) => {
            let cursor = after(&query(request.uri(), "after").unwrap_or_else(|| "0".into()))?;
            Ok(json_response(
                json!(c.run_events(&actor, id(run)?, cursor).await?),
                200,
            ))
        }
        ("DELETE", ["runs", run]) => Ok(json_response(
            json!(c.cancel_run(&actor, id(run)?).await?),
            200,
        )),
        ("POST", ["approvals", approval]) => {
            let input = body(request).await?;
            if input.as_object().is_none_or(|o| o.len() != 1) {
                return Err(invalid());
            }
            let decision =
                serde_json::from_value(input["decision"].clone()).map_err(|_| invalid())?;
            Ok(stream(
                c.resolve_approval(&actor, id(approval)?, decision, None)
                    .await?,
                actor,
                db.clone(),
            ))
        }
        ("POST", ["local-runs"]) => {
            // Fail configuration before publishing a run whose callback token
            // could not be minted.
            if settings.local_secret.encode_utf16().count() < 32 {
                return Err(unavailable());
            }
            let prepared = c.prepare_local(&actor, body(request).await?).await?;
            let ingest=tokens::mint(&settings.local_secret,Kind::LocalIngest,json!({"sub":actor.user_id,"workspaceId":actor.workspace_id,"runId":prepared.run.id,"threadId":prepared.thread.id,"tokenId":Uuid::new_v4()}),(settings.now)(),900.).map_err(|_|unavailable())?;
            Ok(json_response(
                json!({"run":prepared.run,"initialEvents":prepared.initial_events,"runtimeSessionId":prepared.runtime_session_id,"attachments":prepared.attachments,"ingestToken":ingest}),
                201,
            ))
        }
        ("PATCH", ["local-runs", run]) => {
            local_token(settings, request.headers(), &actor, run)?;
            c.checkpoint_local(&actor, id(run)?, body(request).await?)
                .await?;
            Ok(json_response(json!({"ok":true}), 200))
        }
        ("POST", ["local-ingest"]) => {
            let headers = request.headers().clone();
            let input = contracts::local_events(body(request).await?).map_err(|_| invalid())?;
            let run = input["runId"].as_str().unwrap();
            local_token(settings, &headers, &actor, run)?;
            Ok(json_response(
                json!(
                    c.ingest_local(&actor, id(run)?, input["events"].clone())
                        .await?
                ),
                200,
            ))
        }
        ("POST", ["local-tool-calls"]) => {
            let headers = request.headers().clone();
            let input = contracts::local_tool(body(request).await?).map_err(|_| invalid())?;
            let run = input["runId"].as_str().unwrap();
            let claims = local_token(settings, &headers, &actor, run)?;
            // The gateway rechecks current run authority in its own transaction.
            let agent = Actor {
                authentication: Authentication::Agent {
                    run_id: run.into(),
                    token_id: claims["tokenId"].as_str().unwrap().into(),
                },
                scopes: Some(vec![ApiScope::TeamsRead]),
                ..actor
            };
            let capability = match input["tool"].as_str().unwrap() {
                "teams_list" => "teams.list",
                "teams_get" => "teams.get",
                _ => "workspace.describe",
            };
            let result=settings.capabilities.invoke(&agent,json!({"capabilityId":capability,"capabilityVersion":"1","input":input["arguments"]}),id(run)?).await;
            Ok(json_response(
                if result["ok"] == true {
                    json!({"success":true,"output":result["value"]})
                } else {
                    json!({"success":false,"output":{"code":result["errorCode"],"message":result["errorMessage"]}})
                },
                200,
            ))
        }
        ("POST", ["attachments"]) => Err(failure(
            410,
            "DIRECT_UPLOAD_REQUIRED",
            "Use /api/files/uploads/ to upload bytes directly to storage.",
        )),
        ("GET", ["artifacts", artifact]) => Ok(json_response(
            c.attachments
                .as_ref()
                .ok_or_else(unavailable)?
                .artifact_download(&actor, id(artifact)?, &settings.artifact_secret)
                .await?,
            200,
        )),
        ("GET", ["artifacts", artifact, "content"]) => {
            let token = query(request.uri(), "token")
                .filter(|s| s.chars().count() >= 20)
                .ok_or_else(invalid)?;
            let verify = || {
                tokens::verify_artifact(
                    &settings.artifact_secret,
                    &token,
                    &actor,
                    artifact,
                    (settings.now)(),
                )
                .map_err(|_| {
                    failure(
                        403,
                        "FORBIDDEN",
                        "The artifact access token is invalid or expired.",
                    )
                })
            };
            verify()?;
            let (file, content) = c
                .attachments
                .as_ref()
                .ok_or_else(unavailable)?
                .read_artifact(&actor, id(artifact)?)
                .await?;
            verify()?;
            crate::files::render::download(
                &forge_core::files::delivery::File {
                    id: artifact.to_string(),
                    name: file["name"].as_str().unwrap_or("download").into(),
                    content_type: file["contentType"]
                        .as_str()
                        .unwrap_or("application/octet-stream")
                        .into(),
                    size_bytes: content.len(),
                    checksum: String::new(),
                    storage_reference: String::new(),
                },
                content,
            )
            .map_err(|_| {
                failure(
                    500,
                    "INTERNAL_ERROR",
                    "The agent request could not be completed.",
                )
            })
        }
        ("GET", ["models"]) => {
            let models = settings
                .models
                .catalog(&actor, false)
                .await?
                .into_iter()
                .filter(|m| {
                    let provider = m["provider"].as_str().unwrap_or("").to_lowercase();
                    policy::provider_enabled(&settings.features, &provider)
                        && c.controls["allowedProviders"]
                            .as_array()
                            .is_none_or(|p| p.iter().any(|p| p == &provider))
                })
                .collect::<Vec<_>>();
            Ok(json_response(json!(models), 200))
        }
        ("GET", ["connections"]) => Ok(json_response(
            json!(settings.models.list(&actor).await?),
            200,
        )),
        ("POST", ["connections"]) => Ok(json_response(
            settings.models.create(&actor, body(request).await?).await?,
            201,
        )),
        ("POST", ["connections", connection]) => {
            let input = body(request).await?;
            if input != json!({"action":"refresh"}) && input != json!({"action":"test"}) {
                return Err(invalid());
            }
            Ok(json_response(
                settings.models.refresh(&actor, id(connection)?).await?,
                200,
            ))
        }
        ("DELETE", ["connections", connection]) => Ok(json_response(
            settings.models.delete(&actor, id(connection)?).await?,
            200,
        )),
        _ => Err(failure(
            404,
            "NOT_FOUND",
            "The agent endpoint was not found.",
        )),
    }
}
