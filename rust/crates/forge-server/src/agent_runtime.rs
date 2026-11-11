//! EVE transport with durable NDJSON offsets and cancellation after restart.
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use forge_core::{
    actor::{Actor, Authentication},
    agents::{
        eve::{self, Cursor},
        runtime::{Context, Error, Events, Runtime},
        tokens::{self, Kind},
    },
    canonical::javascript_stringify,
};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use url::Url;

#[async_trait]
pub trait PeerIdentity: Send + Sync {
    async fn token(&self) -> Result<String, Error>;
}
pub struct Options {
    pub base_url: Url,
    pub channel_secret: String,
    pub capability_secret: String,
    pub model_secret: String,
    pub peer_origin: Option<Url>,
    pub peer_identity: Option<Arc<dyn PeerIdentity>>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}
#[derive(Clone)]
struct Active {
    owner: uuid::Uuid,
    cursor: Cursor,
    token: String,
}
struct Inner {
    options: Options,
    client: reqwest::Client,
    active: Mutex<HashMap<String, Active>>,
}
#[derive(Clone)]
pub struct EveRuntime(Arc<Inner>);
impl EveRuntime {
    pub fn new(options: Options) -> Result<Self, Error> {
        if options.peer_origin.is_some() != options.peer_identity.is_some() {
            return Err(Error(
                "A reviewed peer origin and its identity provider must be configured together.",
            ));
        }
        if !["http", "https"].contains(&options.base_url.scheme())
            || !options.base_url.username().is_empty()
            || options.base_url.password().is_some()
        {
            return Err(Error("The runtime endpoint configuration is invalid."));
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| Error("The runtime HTTP client is unavailable."))?;
        Ok(Self(Arc::new(Inner {
            options,
            client,
            active: Mutex::new(HashMap::new()),
        })))
    }
    fn channel(&self, context: &Context, cancel: bool) -> Result<String, Error> {
        let now = (self.0.options.now)();
        let (capability, model) = if cancel {
            (
                "forge-cancellation-only-capability".into(),
                "forge-cancellation-only-model-access".into(),
            )
        } else {
            let actor = Actor {
                user_id: context.identity.user_id.clone(),
                workspace_id: context.identity.workspace_id.clone(),
                workspace_role: context.identity.workspace_role.clone(),
                authentication: Authentication::Agent {
                    run_id: context.run_id.clone(),
                    token_id: uuid::Uuid::new_v4().to_string(),
                },
                scopes: None,
                loop_scope: None,
            };
            let capabilities = [
                "teams.list",
                "teams.get",
                "workspace.describe",
                "teams.update",
                "artifacts.create",
            ]
            .map(str::to_owned);
            let capability = tokens::mint(
                &self.0.options.capability_secret,
                Kind::Capability,
                tokens::capability_claims(
                    &actor,
                    &context.run_id,
                    &uuid::Uuid::new_v4().to_string(),
                    &capabilities,
                ),
                now,
                900.,
            )
            .map_err(|_| Error("The capability credential is unavailable."))?;
            let model=tokens::mint(&self.0.options.model_secret,Kind::ModelAccess,json!({"workspaceId":actor.workspace_id,"runId":context.run_id,"connectionId":context.model["connectionId"],"provider":context.model["provider"],"modelId":context.model["modelId"],"tokenId":uuid::Uuid::new_v4(),"sub":actor.user_id}),now,900.).map_err(|_|Error("The model credential is unavailable."))?;
            (capability, model)
        };
        let mut payload =
            json!({"workspaceId":context.identity.workspace_id,"runId":context.run_id});
        if !cancel {
            payload["correlationId"] =
                json!(context.correlation_id.as_deref().unwrap_or(&context.run_id));
        }
        for (key, value) in [
            ("forgeCapabilityToken", json!(capability)),
            ("forgeModelAccessToken", json!(model)),
            ("provider", context.model["provider"].clone()),
            ("modelId", context.model["modelId"].clone()),
            ("reasoningEffort", json!(context.reasoning_effort)),
            ("sub", json!(context.identity.user_id)),
            ("iss", json!("forge")),
            ("aud", json!("forge-agent-runtime")),
            ("iat", json!(now)),
            ("exp", json!(now + if cancel { 120 } else { 900 })),
        ] {
            payload[key] = value;
        }
        let input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#),
            URL_SAFE_NO_PAD.encode(javascript_stringify(&payload))
        );
        let mut mac = Hmac::<Sha256>::new_from_slice(self.0.options.channel_secret.as_bytes())
            .map_err(|_| Error("The runtime channel credential is unavailable."))?;
        mac.update(input.as_bytes());
        Ok(format!(
            "{input}.{}",
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        ))
    }
    async fn request(
        &self,
        path: &str,
        method: reqwest::Method,
        token: &str,
        body: Option<Value>,
        correlation: Option<&str>,
        timeout: Option<Duration>,
    ) -> Result<reqwest::Response, Error> {
        let url = self
            .0
            .options
            .base_url
            .join(path)
            .map_err(|_| Error("The runtime URL is invalid."))?;
        let mut request = self
            .0
            .client
            .request(method, url.clone())
            .bearer_auth(token);
        if let Some(origin) = &self.0.options.peer_origin {
            if origin.origin() != url.origin() {
                return Err(Error(
                    "The runtime service identity cannot be sent to this origin.",
                ));
            }
            let identity = self
                .0
                .options
                .peer_identity
                .as_ref()
                .ok_or(Error("The runtime service identity is unavailable."))?
                .token()
                .await?;
            request = request.header("x-vercel-trusted-oidc-idp-token", identity);
        }
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(javascript_stringify(&body));
        }
        if let Some(id) = correlation {
            request = request.header("x-correlation-id", id);
        }
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        let response = request
            .send()
            .await
            .map_err(|_| Error("The runtime request failed."))?;
        if response.status().is_redirection() {
            return Err(Error("The runtime request redirected."));
        }
        Ok(response)
    }
    fn stream(&self, context: Context, mode: Mode) -> Events {
        let state = State {
            owner: uuid::Uuid::new_v4(),
            runtime: self.clone(),
            context,
            mode: Some(mode),
            cursor: None,
            token: String::new(),
            response: None,
            buffer: Vec::new(),
            queue: VecDeque::new(),
            terminal: false,
            first_line: true,
        };
        Box::pin(futures_util::stream::try_unfold(
            state,
            |mut state| async move {
                state
                    .next()
                    .await
                    .map(|value| value.map(|value| (value, state)))
            },
        ))
    }
}
enum Mode {
    Start {
        message: String,
        attachments: Vec<Value>,
    },
    Resume(Vec<Value>),
    Reconnect,
}
struct State {
    owner: uuid::Uuid,
    runtime: EveRuntime,
    context: Context,
    mode: Option<Mode>,
    cursor: Option<Cursor>,
    token: String,
    response: Option<reqwest::Response>,
    buffer: Vec<u8>,
    queue: VecDeque<Value>,
    terminal: bool,
    first_line: bool,
}
impl State {
    fn release(&self) -> Result<(), Error> {
        let mut active = self
            .runtime
            .0
            .active
            .lock()
            .map_err(|_| Error("The runtime state is unavailable."))?;
        if active
            .get(&self.context.run_id)
            .is_some_and(|entry| entry.owner == self.owner)
        {
            active.remove(&self.context.run_id);
        }
        Ok(())
    }
    async fn initialize(&mut self, mode: Mode) -> Result<(), Error> {
        let previous = self
            .context
            .runtime_session_id
            .as_deref()
            .and_then(Cursor::decode);
        self.token = self.runtime.channel(&self.context, false)?;
        let cursor = match mode {
            Mode::Reconnect => {
                previous.ok_or(Error("EVE reconnect requires a durable session cursor."))?
            }
            mode => {
                if matches!(mode, Mode::Resume(_))
                    && previous
                        .as_ref()
                        .and_then(|v| v.continuation_token.as_ref())
                        .is_none()
                {
                    return Err(Error(
                        "EVE approval resume requires a durable continuation token.",
                    ));
                }
                let path = previous.as_ref().map_or("/eve/v1/session".into(), |c| {
                    format!("/eve/v1/session/{}", component(&c.session_id))
                });
                let mut payload = json!({});
                if let Some(token) = previous
                    .as_ref()
                    .and_then(|v| v.continuation_token.as_ref())
                {
                    payload["continuationToken"] = json!(token);
                }
                match mode {
                    Mode::Start {
                        message,
                        attachments,
                    } => {
                        payload["message"] = if attachments.is_empty() {
                            json!(message)
                        } else {
                            let mut parts = vec![json!({"type":"text","text":message})];
                            for attachment in attachments {
                                parts.push(json!({"type":"file","data":format!("data:{};base64,{}",attachment["contentType"].as_str().ok_or(Error("The runtime attachment is invalid."))?,attachment["contentBase64"].as_str().ok_or(Error("The runtime attachment is invalid."))?),"mediaType":attachment["contentType"],"filename":attachment["name"]}));
                            }
                            json!(parts)
                        };
                    }
                    Mode::Resume(responses) => payload["inputResponses"] = json!(responses),
                    Mode::Reconnect => unreachable!(),
                }
                let response = self
                    .runtime
                    .request(
                        &path,
                        reqwest::Method::POST,
                        &self.token,
                        Some(payload),
                        Some(
                            self.context
                                .correlation_id
                                .as_deref()
                                .unwrap_or(&self.context.run_id),
                        ),
                        Some(Duration::from_secs(30)),
                    )
                    .await?;
                if !response.status().is_success() {
                    return Err(Error("EVE session delivery failed."));
                }
                let value = bounded_json(response).await?;
                let session = value["sessionId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or(Error("The runtime session response is invalid."))?;
                if value["ok"] != true {
                    return Err(Error("The runtime session response is invalid."));
                }
                let continuation = match value.get("continuationToken") {
                    None => previous.as_ref().and_then(|c| c.continuation_token.clone()),
                    Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
                    _ => return Err(Error("The runtime session response is invalid.")),
                };
                let cursor = Cursor {
                    session_id: session.into(),
                    continuation_token: continuation,
                    stream_index: previous.as_ref().map_or(0, |c| c.stream_index),
                };
                self.runtime
                    .0
                    .active
                    .lock()
                    .map_err(|_| Error("The runtime state is unavailable."))?
                    .insert(
                        self.context.run_id.clone(),
                        Active {
                            owner: self.owner,
                            cursor: cursor.clone(),
                            token: self.token.clone(),
                        },
                    );
                self.context.checkpoint.save(cursor.encode()).await?;
                cursor
            }
        };
        self.runtime
            .0
            .active
            .lock()
            .map_err(|_| Error("The runtime state is unavailable."))?
            .insert(
                self.context.run_id.clone(),
                Active {
                    owner: self.owner,
                    cursor: cursor.clone(),
                    token: self.token.clone(),
                },
            );
        let response = self
            .runtime
            .request(
                &format!(
                    "/eve/v1/session/{}/stream?startIndex={}",
                    component(&cursor.session_id),
                    cursor.stream_index
                ),
                reqwest::Method::GET,
                &self.token,
                None,
                None,
                Some(Duration::from_secs(900)),
            )
            .await?;
        if !response.status().is_success() {
            return Err(Error("EVE session stream failed."));
        }
        self.cursor = Some(cursor);
        self.response = Some(response);
        Ok(())
    }
    async fn next(&mut self) -> Result<Option<Value>, Error> {
        if let Some(mode) = self.mode.take() {
            self.initialize(mode).await?;
        }
        loop {
            if let Some(value) = self.queue.pop_front() {
                if self.terminal && self.queue.is_empty() {
                    self.release()?;
                }
                return Ok(Some(value));
            }
            if self.terminal {
                self.release()?;
                return Ok(None);
            }
            if let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
                let line: Vec<_> = self.buffer.drain(..=end).collect();
                let decoded = String::from_utf8_lossy(&line);
                let line = if self.first_line {
                    decoded.strip_prefix('\u{feff}').unwrap_or(&decoded)
                } else {
                    &decoded
                };
                self.first_line = false;
                if forge_core::text::trim(line).is_empty() {
                    continue;
                }
                let cursor = self
                    .cursor
                    .as_mut()
                    .ok_or(Error("The runtime cursor is unavailable."))?;
                cursor.stream_index = cursor
                    .stream_index
                    .checked_add(1)
                    .filter(|n| *n <= 9_007_199_254_740_991)
                    .ok_or(Error("The runtime cursor exceeded its supported range."))?;
                let value = forge_core::json::parse(line)
                    .map_err(|_| Error("The runtime event is invalid."))?;
                eve::basic(&value).map_err(|_| Error("The runtime event is invalid."))?;
                if value["type"] == "session.waiting"
                    && let Some(token) = value["data"]["continuationToken"].as_str()
                {
                    cursor.continuation_token = Some(token.into());
                }
                {
                    let mut active = self
                        .runtime
                        .0
                        .active
                        .lock()
                        .map_err(|_| Error("The runtime state is unavailable."))?;
                    let entry = active
                        .get_mut(&self.context.run_id)
                        .filter(|entry| entry.owner == self.owner)
                        .ok_or(Error("The runtime stream has been superseded."))?;
                    entry.cursor = cursor.clone();
                }
                self.context.checkpoint.save(cursor.encode()).await?;
                self.queue = eve::normalize(
                    value.clone(),
                    &cursor.session_id,
                    Some(cursor.stream_index as f64),
                )
                .map_err(|_| Error("The runtime event is invalid."))?
                .into();
                self.terminal = matches!(
                    value["type"].as_str(),
                    Some("session.waiting" | "session.failed" | "turn.failed" | "turn.cancelled")
                );
            } else {
                let chunk = self
                    .response
                    .as_mut()
                    .ok_or(Error("The runtime stream is unavailable."))?
                    .chunk()
                    .await
                    .map_err(|_| Error("The runtime stream failed."))?;
                if let Some(chunk) = chunk {
                    if self.buffer.len() + chunk.len() > 8 * 1024 * 1024 {
                        return Err(Error("The runtime event exceeded its size limit."));
                    }
                    self.buffer.extend(chunk);
                } else {
                    self.terminal = true;
                }
            }
        }
    }
}
#[async_trait]
impl Runtime for EveRuntime {
    fn kind(&self) -> &'static str {
        "eve"
    }
    fn start(&self, context: Context, message: String, attachments: Vec<Value>) -> Events {
        self.stream(
            context,
            Mode::Start {
                message,
                attachments,
            },
        )
    }
    fn resume(&self, context: Context, responses: Vec<Value>) -> Events {
        self.stream(context, Mode::Resume(responses))
    }
    fn reconnect(&self, context: Context) -> Events {
        self.stream(context, Mode::Reconnect)
    }
    async fn cancel(
        &self,
        run: &str,
        cursor: Option<&str>,
        context: Option<&Context>,
    ) -> Result<(), Error> {
        let active = self
            .0
            .active
            .lock()
            .map_err(|_| Error("The runtime state is unavailable."))?
            .get(run)
            .cloned();
        let cursor = active
            .as_ref()
            .map(|a| a.cursor.clone())
            .or_else(|| cursor.and_then(Cursor::decode));
        let token = match active {
            Some(a) => Some(a.token),
            None => context
                .map(|context| {
                    let mut context = context.clone();
                    context.run_id = run.into();
                    self.channel(&context, true)
                })
                .transpose()?,
        };
        if let (Some(cursor), Some(token)) = (cursor, token) {
            self.request(
                &format!("/eve/v1/session/{}/cancel", component(&cursor.session_id)),
                reqwest::Method::POST,
                &token,
                Some(json!({})),
                None,
                None,
            )
            .await?;
        }
        Ok(())
    }
}
async fn bounded_json(mut response: reqwest::Response) -> Result<Value, Error> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Error("The runtime session response failed."))?
    {
        if bytes.len() + chunk.len() > 128 * 1024 {
            return Err(Error("The runtime session response is too large."));
        }
        bytes.extend(chunk);
    }
    let text = String::from_utf8_lossy(&bytes);
    forge_core::json::parse(text.strip_prefix('\u{feff}').unwrap_or(&text))
        .map_err(|_| Error("The runtime session response is invalid."))
}
fn component(value: &str) -> String {
    let mut result = String::new();
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            result.push(char::from(b));
        } else {
            use std::fmt::Write;
            let _ = write!(result, "%{b:02X}");
        }
    }
    result
}
