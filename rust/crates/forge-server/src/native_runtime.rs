//! Application adapter for the private native runtime protocol. The existing
//! public event vocabulary remains `eve`; no browser protocol changes are needed.
use crate::agent_runtime::{EveRuntime, Options, bounded_json};
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use forge_core::{
    agents::{
        eve,
        runtime::{Context, Error, Events, Runtime},
    },
    canonical::javascript_stringify,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::time::{sleep, timeout};
use uuid::Uuid;
const LINE_LIMIT: usize = 8 * 1024 * 1024 + 1024;
const FAILED: Error = Error("The native agent runtime could not complete this request.");
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Settled {
    Questions,
    Complete,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cursor {
    pub conversation_id: Uuid,
    pub run_id: Uuid,
    pub previous_run_id: Option<Uuid>,
    pub stream_index: u64,
    pub deadline_ms: i64,
    #[serde(default)]
    pub admitted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled: Option<Settled>,
}
impl Cursor {
    pub fn encode(&self) -> String {
        format!(
            "native-v1.{}",
            URL_SAFE_NO_PAD.encode(javascript_stringify(&json!(self)))
        )
    }
    pub fn decode(value: &str) -> Option<Self> {
        if value.len() > 4096 {
            return None;
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(value.strip_prefix("native-v1.")?)
            .ok()?;
        let value: Self = serde_json::from_slice(&bytes).ok()?;
        if value.stream_index > 9_007_199_254_740_991
            || value.previous_run_id == Some(value.run_id)
            || chrono::DateTime::from_timestamp_millis(value.deadline_ms).is_none()
        {
            return None;
        }
        Some(value)
    }
}
struct Active {
    owner: Uuid,
    token: String,
}
struct Inner {
    transport: EveRuntime,
    active: Mutex<HashMap<String, Active>>,
}
#[derive(Clone)]
pub struct NativeRuntime(Arc<Inner>);
impl NativeRuntime {
    pub fn new(options: Options) -> Result<Self, Error> {
        Ok(Self(Arc::new(Inner {
            transport: EveRuntime::new(options)?,
            active: Mutex::new(HashMap::new()),
        })))
    }
    fn stream(&self, context: Context, mode: Mode) -> Events {
        let state = Stream {
            runtime: self.clone(),
            context,
            mode: Some(mode),
            owner: Uuid::new_v4(),
            token: String::new(),
            cursor: None,
            response: None,
            buffer: vec![],
            queue: VecDeque::new(),
            pending_checkpoint: false,
            done: false,
            terminal_seen: false,
            waiting_seen: false,
        };
        Box::pin(futures_util::stream::try_unfold(
            state,
            |mut state| async move {
                state
                    .next()
                    .await
                    .map(|event| event.map(|event| (event, state)))
            },
        ))
    }
    async fn post(
        &self,
        path: &str,
        token: &str,
        body: Value,
        correlation: Option<&str>,
        run: &str,
    ) -> Result<(), Error> {
        // Every POST is idempotent: admission, decision receipt, recovery or
        // cancellation. A lost acknowledgement can safely retry the same body.
        for attempt in 0..3 {
            let result = timeout(
                Duration::from_secs(30),
                self.0.transport.request(
                    path,
                    reqwest::Method::POST,
                    token,
                    Some(body.clone()),
                    correlation,
                    Some(Duration::from_secs(30)),
                ),
            )
            .await;
            match result {
                Ok(Ok(response)) if response.status().is_success() => {
                    match timeout(Duration::from_secs(5), bounded_json(response)).await {
                        Ok(Ok(value)) if value["ok"] == true && value["runId"] == run => {
                            return Ok(());
                        }
                        Ok(Ok(_)) => return Err(FAILED),
                        _ => {}
                    }
                }
                Ok(Ok(response))
                    if !response.status().is_server_error()
                        && response.status() != reqwest::StatusCode::TOO_MANY_REQUESTS =>
                {
                    return Err(FAILED);
                }
                _ => {}
            }
            if attempt < 2 {
                sleep(Duration::from_millis(100 * (attempt + 1))).await;
            }
        }
        Err(FAILED)
    }
}
enum Mode {
    Start(String, Vec<Value>),
    Resume(Vec<Value>),
    Reconnect,
}
struct Stream {
    runtime: NativeRuntime,
    context: Context,
    mode: Option<Mode>,
    owner: Uuid,
    token: String,
    cursor: Option<Cursor>,
    response: Option<reqwest::Response>,
    buffer: Vec<u8>,
    queue: VecDeque<Value>,
    pending_checkpoint: bool,
    done: bool,
    terminal_seen: bool,
    waiting_seen: bool,
}
impl Stream {
    fn owned(&self) -> Result<(), Error> {
        if self
            .runtime
            .0
            .active
            .lock()
            .map_err(|_| FAILED)?
            .get(&self.context.run_id)
            .is_some_and(|active| active.owner == self.owner)
        {
            Ok(())
        } else {
            Err(Error("The native runtime stream has been superseded."))
        }
    }
    async fn initialize(&mut self, mode: Mode) -> Result<(), Error> {
        let run: Uuid = self.context.run_id.parse().map_err(|_| FAILED)?;
        let conversation: Uuid = self.context.thread_id.parse().map_err(|_| FAILED)?;
        let previous = self
            .context
            .runtime_session_id
            .as_deref()
            .map(|value| {
                Cursor::decode(value).ok_or(Error(
                    "This conversation needs migration before using the native runtime.",
                ))
            })
            .transpose()?;
        if previous
            .as_ref()
            .is_some_and(|cursor| cursor.conversation_id != conversation)
        {
            return Err(FAILED);
        }
        let mut cursor = match &mode {
            Mode::Start(_, _) if previous.as_ref().is_some_and(|cursor| cursor.run_id == run) => {
                previous.clone().unwrap()
            }
            Mode::Start(_, _) => Cursor {
                conversation_id: conversation,
                run_id: run,
                previous_run_id: previous.as_ref().map(|c| c.run_id),
                stream_index: 0,
                deadline_ms: self.context.deadline_ms,
                admitted: false,
                settled: None,
            },
            _ => previous.filter(|cursor| cursor.run_id == run).ok_or(Error(
                "Native runtime recovery requires this run's saved cursor.",
            ))?,
        };
        self.token = self.runtime.0.transport.channel(&self.context, false)?;
        self.runtime.0.active.lock().map_err(|_| FAILED)?.insert(
            self.context.run_id.clone(),
            Active {
                owner: self.owner,
                token: self.token.clone(),
            },
        );
        let base = format!("/native/v1/runs/{run}");
        let (path, body) = match mode {
            Mode::Start(message, attachments) => {
                let attachments=attachments.into_iter().map(|a|{
                    if ["name","contentType","contentBase64"].iter().any(|k|!a[*k].is_string()) { return Err(FAILED); }
                    Ok(json!({"name":a["name"],"contentType":a["contentType"],"contentBase64":a["contentBase64"]}))
                }).collect::<Result<Vec<_>,Error>>()?;
                (
                    base.clone(),
                    json!({"conversationId":conversation,"previousRunId":cursor.previous_run_id,"message":message,"attachments":attachments,"deadline":cursor.deadline_ms}),
                )
            }
            Mode::Resume(responses) => {
                if responses.len() != 1 {
                    return Err(FAILED);
                }
                let response = &responses[0];
                let request = response["requestId"]
                    .as_str()
                    .filter(|v| Uuid::parse_str(v).is_ok())
                    .ok_or(FAILED)?;
                let approved = match response["optionId"].as_str() {
                    Some("approve") => true,
                    Some("deny") => false,
                    _ => return Err(FAILED),
                };
                (
                    format!("{base}/resume"),
                    json!({"requestId":request,"approved":approved}),
                )
            }
            Mode::Reconnect => (format!("{base}/recover"), json!({})),
        };
        self.owned()?;
        self.context.checkpoint.save(cursor.encode()).await?;
        self.runtime
            .post(
                &path,
                &self.token,
                body,
                self.context.correlation_id.as_deref(),
                &self.context.run_id,
            )
            .await?;
        self.owned()?;
        cursor.admitted = true;
        self.context.checkpoint.save(cursor.encode()).await?;
        let response = timeout(
            Duration::from_secs(30),
            self.runtime.0.transport.request(
                &format!("{base}/stream?after={}", cursor.stream_index),
                reqwest::Method::GET,
                &self.token,
                None,
                None,
                Some(Duration::from_secs(900)),
            ),
        )
        .await
        .map_err(|_| FAILED)??;
        if !response.status().is_success()
            || !response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| {
                    v.split(';')
                        .next()
                        .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/x-ndjson"))
                })
        {
            return Err(FAILED);
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
            self.owned()?;
            if let Some(event) = self.queue.pop_front() {
                return Ok(Some(event));
            }
            // The coordinator awaits persistence of the previously yielded event
            // before polling again. A dropped/failed consumer keeps the earlier
            // offset, and replay is deduplicated by stable public source IDs.
            if self.pending_checkpoint {
                self.context
                    .checkpoint
                    .save(self.cursor.as_ref().ok_or(FAILED)?.encode())
                    .await?;
                self.pending_checkpoint = false;
            }
            if self.done {
                return Ok(None);
            }
            if let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
                if end > LINE_LIMIT {
                    return Err(FAILED);
                }
                let bytes = self.buffer.drain(..=end).collect::<Vec<_>>();
                let line = std::str::from_utf8(&bytes).map_err(|_| FAILED)?;
                if line.trim().is_empty() {
                    continue;
                }
                let frame = forge_core::json::parse(line).map_err(|_| FAILED)?;
                if frame.get("error").is_some() {
                    return Err(FAILED);
                }
                let cursor = self.cursor.as_mut().ok_or(FAILED)?;
                if let Some(status) = frame.get("status") {
                    if frame.as_object().is_none_or(|o| o.len() != 1)
                        || !matches!(
                            status["phase"].as_str(),
                            Some("waiting" | "complete" | "failed")
                        ) && status["cancelled"] != true
                        || status["nextIndex"].as_u64() != Some(cursor.stream_index)
                    {
                        return Err(FAILED);
                    }
                    let pending = status.get("pendingRequests").and_then(Value::as_array);
                    let questions = pending.filter(|requests| {
                        !requests.is_empty()
                            && requests.iter().all(|request| {
                                request["kind"] == "question"
                                    && request["action"]["toolName"] == "ask_question"
                                    && matches!(
                                        request["display"].as_str(),
                                        Some("text" | "select")
                                    )
                            })
                    });
                    let mut question_events = if let Some(requests) = questions {
                        if status["phase"] != "waiting" || status["cancelled"] == true {
                            return Err(FAILED);
                        }
                        eve::normalize(
                            json!({"type":"input.requested","data":{"requests":requests}}),
                            &format!("native:{}", cursor.run_id),
                            Some(cursor.stream_index as f64),
                        )
                        .map_err(|_| FAILED)?
                        .into_iter()
                        .map(|event| {
                            forge_core::agents::presentation::native_event(event)
                                .map_err(|_| FAILED)
                        })
                        .collect::<Result<Vec<_>, _>>()?
                    } else {
                        vec![]
                    };
                    cursor.settled = if status["cancelled"] == true {
                        None
                    } else if status["phase"] == "complete" {
                        Some(Settled::Complete)
                    } else if questions.is_some() {
                        Some(Settled::Questions)
                    } else {
                        None
                    };
                    // All earlier normalized batch entries were persisted before
                    // this terminal status was read. Only now certify the head;
                    // the first question alone must never authorize continuation.
                    self.context.checkpoint.save(cursor.encode()).await?;
                    let kind = if status["cancelled"] == true {
                        Some("run.cancelled")
                    } else {
                        match status["phase"].as_str() {
                            Some("complete") => Some("run.completed"),
                            Some("failed") => Some("run.failed"),
                            _ => None,
                        }
                    };
                    if let Some(kind) = kind {
                        if !self.terminal_seen {
                            self.queue.push_back(json!({"sourceEventId":format!("native:{}:status:{kind}",cursor.run_id),"source":"eve","type":kind,"payload":if kind=="run.failed"{json!({"code":"RUNTIME_EXECUTION_FAILED","message":"The native runtime run failed."})}else{json!({})}}));
                        }
                    } else if !self.waiting_seen {
                        if !question_events.is_empty() {
                            for (index, event) in question_events.iter_mut().enumerate() {
                                event["sourceEventId"] = json!(format!(
                                    "native:{}:waiting:{}:{index}",
                                    cursor.run_id, self.owner
                                ));
                            }
                            self.queue.extend(question_events);
                            self.done = true;
                            continue;
                        }
                        let request = status["pendingRequestId"]
                            .as_str()
                            .filter(|v| Uuid::parse_str(v).is_ok())
                            .ok_or(FAILED)?;
                        // A fresh stream may start after the approval event's
                        // offset. Reassert waiting for the coordinator's current
                        // recovery epoch without requesting another approval.
                        self.queue.push_back(json!({"sourceEventId":format!("native:{}:waiting:{}",cursor.run_id,self.owner),"source":"eve","type":"run.waiting","payload":{"reason":"input-required","requestId":request}}));
                    }
                    self.done = true;
                    continue;
                }
                if frame.as_object().is_none_or(|o| o.len() != 2)
                    || frame["index"].as_u64() != Some(cursor.stream_index)
                {
                    return Err(FAILED);
                }
                let event = frame.get("event").ok_or(FAILED)?.clone();
                // The stream belongs to one run; event metadata cannot redirect
                // the public event's identity to a different conversation/run.
                if event["data"]
                    .get("turnId")
                    .is_some_and(|v| v != &json!(cursor.run_id))
                {
                    return Err(FAILED);
                }
                let sources = event["data"]["sources"].clone();
                self.queue = eve::normalize(
                    event,
                    &format!("native:{}", cursor.run_id),
                    Some(cursor.stream_index as f64),
                )
                .map_err(|_| FAILED)?
                .into_iter()
                .map(|event| {
                    let event = forge_core::agents::presentation::native_sources(event, &sources)
                        .map_err(|_| FAILED)?;
                    forge_core::agents::presentation::native_event(event).map_err(|_| FAILED)
                })
                .collect::<Result<VecDeque<_>, _>>()?;
                self.terminal_seen |= self.queue.iter().any(|e| {
                    matches!(
                        e["type"].as_str(),
                        Some("run.completed" | "run.failed" | "run.cancelled")
                    )
                });
                self.waiting_seen |= self.queue.iter().any(|e| {
                    matches!(
                        e["type"].as_str(),
                        Some("approval.requested" | "run.waiting")
                    )
                });
                cursor.stream_index = cursor
                    .stream_index
                    .checked_add(1)
                    .filter(|n| *n <= 9_007_199_254_740_991)
                    .ok_or(FAILED)?;
                self.pending_checkpoint = true;
            } else {
                if self.buffer.len() > LINE_LIMIT {
                    return Err(FAILED);
                }
                let chunk = self
                    .response
                    .as_mut()
                    .ok_or(FAILED)?
                    .chunk()
                    .await
                    .map_err(|_| FAILED)?
                    .ok_or(Error(
                        "The native runtime stream ended without a terminal frame.",
                    ))?;
                if self.buffer.len() + chunk.len() > 2 * LINE_LIMIT {
                    return Err(FAILED);
                }
                self.buffer.extend_from_slice(&chunk);
            }
        }
    }
}
impl Drop for Stream {
    fn drop(&mut self) {
        if let Ok(mut active) = self.runtime.0.active.lock()
            && active
                .get(&self.context.run_id)
                .is_some_and(|v| v.owner == self.owner)
        {
            active.remove(&self.context.run_id);
        }
    }
}
#[async_trait]
impl Runtime for NativeRuntime {
    fn kind(&self) -> &'static str {
        "eve"
    }
    fn cursor_run_id(&self, cursor: &str) -> Option<String> {
        Some(Cursor::decode(cursor)?.run_id.to_string())
    }
    fn question_continuation_run(&self, cursor: &str, terminal: bool) -> Option<String> {
        let cursor = Cursor::decode(cursor)?;
        (matches!(cursor.settled, Some(Settled::Questions)) || (terminal && cursor.admitted))
            .then(|| cursor.run_id.to_string())
    }
    fn idempotent_resumption(&self) -> bool {
        true
    }
    fn cancel_after_transport_failure(&self) -> bool {
        true
    }
    fn start(&self, context: Context, message: String, attachments: Vec<Value>) -> Events {
        self.stream(context, Mode::Start(message, attachments))
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
        _cursor: Option<&str>,
        context: Option<&Context>,
    ) -> Result<(), Error> {
        let id: Uuid = run.parse().map_err(|_| FAILED)?;
        let token = if let Some(context) = context {
            if context.run_id != run {
                return Err(FAILED);
            }
            self.0.transport.channel(context, true)?
        } else {
            self.0
                .active
                .lock()
                .map_err(|_| FAILED)?
                .get(run)
                .map(|v| v.token.clone())
                .ok_or(Error("Runtime cancellation requires an owner context."))?
        };
        let response = timeout(
            Duration::from_secs(5),
            self.0.transport.request(
                &format!("/native/v1/runs/{id}/cancel"),
                reqwest::Method::POST,
                &token,
                Some(json!({})),
                None,
                Some(Duration::from_secs(5)),
            ),
        )
        .await
        .map_err(|_| FAILED)??;
        if response.status().is_success() || response.status() == reqwest::StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(FAILED)
        }
    }
}
