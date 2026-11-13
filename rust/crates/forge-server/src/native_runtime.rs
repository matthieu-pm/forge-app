//! Application adapter for the private native runtime protocol. The existing
//! public event vocabulary remains `eve`; no browser protocol changes are needed.
use crate::agent_runtime::{EveRuntime, Options, bounded_json};
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use forge_core::{
    agents::{
        eve,
        runtime::{
            Context, Continuation, ConversationFence, DeliveryFrame, DeliveryPhase,
            DeliveryReceipt, DrainBoundary, Error, Events, HandoffPlan, IntentReceipt,
            ManagedSession, OpenDelivery, Preparation, QueuedInput, Runtime,
        },
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
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn fence_valid(fence: &ConversationFence) -> bool {
    fence.generation <= SAFE_INTEGER
}
fn boundary_valid(boundary: &DrainBoundary) -> bool {
    fence_valid(&boundary.conversation)
        && [&boundary.delivery, &boundary.execution]
            .iter()
            .all(|snapshot| {
                snapshot.input_generation <= SAFE_INTEGER
                    && snapshot.state_revision <= SAFE_INTEGER
                    && snapshot.next_index <= SAFE_INTEGER
                    && (!snapshot.delivery_only || snapshot.phase == DeliveryPhase::Complete)
            })
        && !boundary.execution.delivery_only
}
fn plan_valid(plan: &HandoffPlan) -> bool {
    fence_valid(&plan.conversation)
        && plan.conversation == plan.boundary.conversation
        && boundary_valid(&plan.boundary)
        && (1..=128).contains(&plan.intent_ids.len())
        && plan.intent_ids.first() == Some(&plan.anchor_intent_id)
        && plan
            .intent_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            == plan.intent_ids.len()
        && plan.prefix_end_sequence <= SAFE_INTEGER
        && !plan.authority.provider.is_empty()
        && !plan.authority.model_id.is_empty()
        && !plan.authority.reasoning_effort.is_empty()
}
fn status_boundary(
    status: &Value,
    cursor: &Cursor,
    generation: u64,
) -> Result<DrainBoundary, Error> {
    let boundary: DrainBoundary =
        serde_json::from_value(status["boundary"].clone()).map_err(|_| FAILED)?;
    let proof = cursor.conversation.as_ref().ok_or(FAILED)?;
    let phase: DeliveryPhase =
        serde_json::from_value(status["phase"].clone()).map_err(|_| FAILED)?;
    if !boundary_valid(&boundary)
        || boundary.conversation.conversation_id != cursor.conversation_id
        || boundary.conversation.head_run_id != proof.head_run_id
        || boundary.conversation.generation != proof.generation
        || boundary.delivery.run_id != cursor.run_id
        || boundary.delivery.input_generation != generation
        || boundary.delivery.next_index != status["nextIndex"].as_u64().ok_or(FAILED)?
        || boundary.delivery.phase != phase
        || Some(boundary.delivery.cancelled || phase == DeliveryPhase::Cancelled)
            != status["cancelled"].as_bool()
        || boundary.execution.run_id != proof.owner_run_id
        || boundary.execution.next_index != proof.owner_next_index
        || (boundary.delivery.run_id == boundary.execution.run_id
            && boundary.delivery != boundary.execution)
    {
        return Err(FAILED);
    }
    Ok(boundary)
}
enum PostFailure {
    Rejected(reqwest::StatusCode),
    Unknown,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Settled {
    Questions,
    Inputs,
    Complete,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Conversation {
    pub id: Uuid,
    pub head_run_id: Uuid,
    pub generation: u64,
    pub owner_run_id: Uuid,
    pub owner_next_index: u64,
    pub owner_deadline: i64,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<Conversation>,
    #[serde(default)]
    pub pending_inputs: bool,
    #[serde(default)]
    pub delivery_complete: bool,
}
impl Cursor {
    fn accept_conversation(&mut self, status: &Value) -> Result<(), Error> {
        let Some(value) = status.get("conversation").filter(|v| !v.is_null()) else {
            if self.conversation.is_some() {
                return Err(FAILED);
            }
            return Ok(());
        };
        let proof: Conversation = serde_json::from_value(value.clone()).map_err(|_| FAILED)?;
        if proof.id != self.conversation_id
            || proof.generation > 9_007_199_254_740_991
            || proof.owner_next_index > 9_007_199_254_740_991
            || chrono::DateTime::from_timestamp_millis(proof.owner_deadline).is_none()
            || (proof.head_run_id != self.run_id && proof.owner_run_id != self.run_id)
            || self
                .conversation
                .as_ref()
                .is_some_and(|old| proof.generation < old.generation)
        {
            return Err(FAILED);
        }
        self.conversation = Some(proof);
        Ok(())
    }
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
            || value.conversation.as_ref().is_some_and(|c| {
                c.id != value.conversation_id
                    || c.generation > 9_007_199_254_740_991
                    || c.owner_next_index > 9_007_199_254_740_991
                    || chrono::DateTime::from_timestamp_millis(c.owner_deadline).is_none()
            })
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
    fn state(&self, context: Context, mode: Mode, managed: bool) -> Stream {
        Stream {
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
            managed,
            admission: None,
            parked: None,
        }
    }
    fn stream(&self, context: Context, mode: Mode) -> Events {
        let state = self.state(context, mode, false);
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
    ) -> Result<Value, PostFailure> {
        // Every POST is idempotent: admission, decision receipt, recovery or
        // cancellation. A lost acknowledgement can safely retry the same body.
        let mut uncertain = false;
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
                            return Ok(value);
                        }
                        Ok(Ok(_)) => return Err(PostFailure::Unknown),
                        _ => uncertain = true,
                    }
                }
                Ok(Ok(response))
                    if !response.status().is_server_error()
                        && response.status() != reqwest::StatusCode::TOO_MANY_REQUESTS =>
                {
                    return Err(if uncertain {
                        PostFailure::Unknown
                    } else {
                        PostFailure::Rejected(response.status())
                    });
                }
                _ => uncertain = true,
            }
            if attempt < 2 {
                sleep(Duration::from_millis(100 * (attempt + 1))).await;
            }
        }
        Err(PostFailure::Unknown)
    }
    async fn conversation(&self, id: Uuid, token: &str) -> Result<Conversation, Error> {
        let response = timeout(
            Duration::from_secs(5),
            self.0.transport.request(
                &format!("/native/v1/conversations/{id}"),
                reqwest::Method::GET,
                token,
                None,
                None,
                Some(Duration::from_secs(5)),
            ),
        )
        .await
        .map_err(|_| FAILED)??;
        if !response.status().is_success() {
            return Err(FAILED);
        }
        let value = timeout(Duration::from_secs(5), bounded_json(response))
            .await
            .map_err(|_| FAILED)??;
        if value["ok"] != true {
            return Err(FAILED);
        }
        serde_json::from_value(value["conversation"].clone()).map_err(|_| FAILED)
    }
}
#[allow(clippy::large_enum_variant)]
enum Mode {
    Start(String, Vec<Value>),
    Resume(Vec<Value>),
    Reconnect,
    Managed(OpenDelivery),
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
    managed: bool,
    admission: Option<DeliveryReceipt>,
    parked: Option<DeliveryFrame>,
}
impl Stream {
    fn claim(&self) -> Result<(), Error> {
        self.runtime.0.active.lock().map_err(|_| FAILED)?.insert(
            self.context.run_id.clone(),
            Active {
                owner: self.owner,
                token: self.token.clone(),
            },
        );
        Ok(())
    }
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
        match mode {
            Mode::Managed(delivery) => self.initialize_managed(delivery).await,
            legacy => self.initialize_legacy(legacy).await,
        }
    }
    async fn initialize_legacy(&mut self, mode: Mode) -> Result<(), Error> {
        let prior_checkpoint = self.context.runtime_session_id.clone();
        let admitting = matches!(&mode, Mode::Start(_, _));
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
                previous_run_id: previous
                    .as_ref()
                    .map(|c| c.conversation.as_ref().map_or(c.run_id, |c| c.head_run_id)),
                stream_index: 0,
                deadline_ms: self.context.deadline_ms,
                admitted: false,
                settled: None,
                conversation: previous.as_ref().and_then(|c| c.conversation.clone()),
                pending_inputs: false,
                delivery_complete: false,
            },
            Mode::Resume(_) => {
                let mut cursor = previous.ok_or(Error(
                    "Native runtime recovery requires this run's saved cursor.",
                ))?;
                if cursor.run_id != run {
                    let proof = cursor.conversation.as_ref().ok_or(FAILED)?;
                    cursor.stream_index = if proof.owner_run_id == run {
                        proof.owner_next_index
                    } else {
                        0
                    };
                    cursor.run_id = run;
                    cursor.previous_run_id = None;
                    cursor.deadline_ms = self.context.deadline_ms;
                }
                cursor.settled = None;
                cursor.delivery_complete = false;
                cursor
            }
            _ => previous.filter(|cursor| cursor.run_id == run).ok_or(Error(
                "Native runtime recovery requires this run's saved cursor.",
            ))?,
        };
        self.token = self.runtime.0.transport.channel(&self.context, false)?;
        let base = format!("/native/v1/runs/{run}");
        let resuming = matches!(mode, Mode::Resume(_));
        if !resuming {
            self.claim()?;
        }
        let (path, mut body) = match mode {
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
            Mode::Managed(_) => return Err(FAILED),
        };
        if resuming && cursor.conversation.is_none() {
            // The a1 cursor predates conversation ownership metadata. Migrated
            // sessions still require the current proof, but learning it must not
            // replace the app checkpoint before the response is acknowledged.
            cursor.conversation = Some(self.runtime.conversation(conversation, &self.token).await?);
            if Cursor::decode(&cursor.encode()).is_none() {
                return Err(FAILED);
            }
        }
        if let Some(proof) = &cursor.conversation {
            if resuming {
                body["conversationId"] = json!(conversation);
                body["expectedHeadRunId"] = json!(proof.head_run_id);
                body["expectedGeneration"] = json!(proof.generation);
            } else if path == base {
                body["expectedGeneration"] = json!(proof.generation);
            }
        }
        if !resuming {
            self.owned()?;
            self.context.checkpoint.save(cursor.encode()).await?;
        }
        let mut refreshed = false;
        let acknowledged = loop {
            match self
                .runtime
                .post(
                    &path,
                    &self.token,
                    body.clone(),
                    self.context.correlation_id.as_deref(),
                    &self.context.run_id,
                )
                .await
            {
                Ok(value) => break value,
                Err(PostFailure::Rejected(status)) => {
                    if admitting
                        && !cursor.admitted
                        && !refreshed
                        && status == reqwest::StatusCode::CONFLICT
                    {
                        refreshed = true;
                        if let Ok(proof) =
                            self.runtime.conversation(conversation, &self.token).await
                            && proof.id == conversation
                            && Some(proof.head_run_id) == cursor.previous_run_id
                            && proof.generation
                                > cursor.conversation.as_ref().map_or(0, |p| p.generation)
                        {
                            cursor.conversation = Some(proof);
                            if Cursor::decode(&cursor.encode()).is_some() {
                                body["expectedGeneration"] =
                                    json!(cursor.conversation.as_ref().unwrap().generation);
                                self.context.checkpoint.save(cursor.encode()).await?;
                                continue;
                            }
                        }
                    }
                    if admitting {
                        if let Some(previous) = &prior_checkpoint {
                            self.context.checkpoint.save(previous.clone()).await?;
                        } else {
                            self.context.checkpoint.clear().await?;
                        }
                    }
                    return Err(FAILED);
                }
                Err(PostFailure::Unknown) => return Err(FAILED),
            }
        };
        if acknowledged["currentDelivery"] == false {
            self.done = true;
            return Ok(());
        }
        if resuming && acknowledged["currentDelivery"] != true {
            return Err(FAILED);
        }
        if resuming {
            cursor.accept_conversation(acknowledged.get("status").ok_or(FAILED)?)?;
            cursor.stream_index = acknowledged
                .get("streamStartIndex")
                .ok_or(FAILED)?
                .as_u64()
                .filter(|v| *v <= 9_007_199_254_740_991)
                .ok_or(FAILED)?;
        } else if let Some(status) = acknowledged.get("status") {
            cursor.accept_conversation(status)?;
        }
        cursor.admitted = true;
        // A response may be rejected or replay an older delivery while this
        // run's current stream is still live. Only a validated acknowledgement
        // and its persisted checkpoint authorize taking over that stream.
        if resuming {
            if cursor
                .conversation
                .as_ref()
                .is_some_and(|proof| proof.owner_run_id != run)
            {
                return Err(FAILED);
            }
            self.context.checkpoint.save(cursor.encode()).await?;
            self.claim()?;
            self.owned()?;
        } else {
            self.owned()?;
            self.context.checkpoint.save(cursor.encode()).await?;
        }
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
    async fn initialize_managed(&mut self, delivery: OpenDelivery) -> Result<(), Error> {
        let run: Uuid = self.context.run_id.parse().map_err(|_| FAILED)?;
        let conversation: Uuid = self.context.thread_id.parse().map_err(|_| FAILED)?;
        let prior_checkpoint = self.context.runtime_session_id.clone();
        let previous = prior_checkpoint
            .as_deref()
            .map(|value| Cursor::decode(value).ok_or(FAILED))
            .transpose()?;
        if previous
            .as_ref()
            .is_some_and(|cursor| cursor.conversation_id != conversation)
        {
            return Err(FAILED);
        }
        let starting = matches!(&delivery, OpenDelivery::Start { .. });
        let recovering = matches!(&delivery, OpenDelivery::Recover { .. });
        let base = format!("/native/v1/runs/{run}");
        let mut cursor = if starting {
            previous
                .as_ref()
                .filter(|cursor| cursor.run_id == run)
                .cloned()
                .unwrap_or_else(|| Cursor {
                    conversation_id: conversation,
                    run_id: run,
                    previous_run_id: previous.as_ref().map(|cursor| {
                        cursor
                            .conversation
                            .as_ref()
                            .map_or(cursor.run_id, |proof| proof.head_run_id)
                    }),
                    stream_index: 0,
                    deadline_ms: self.context.deadline_ms,
                    admitted: false,
                    settled: None,
                    conversation: previous
                        .as_ref()
                        .and_then(|cursor| cursor.conversation.clone()),
                    pending_inputs: false,
                    delivery_complete: false,
                })
        } else {
            let mut cursor = previous.ok_or(Error(
                "Native runtime recovery requires this run's saved cursor.",
            ))?;
            if recovering && cursor.run_id != run {
                return Err(FAILED);
            }
            if !recovering {
                cursor.run_id = run;
                cursor.previous_run_id = None;
                cursor.deadline_ms = self.context.deadline_ms;
            }
            cursor
        };
        let (path, body, generation, handoff) = match delivery {
            OpenDelivery::Start {
                message,
                attachments,
            } => {
                let attachments = attachments
                    .into_iter()
                    .map(|attachment| {
                        if ["name", "contentType", "contentBase64"]
                            .iter()
                            .any(|key| !attachment[*key].is_string())
                        {
                            return Err(FAILED);
                        }
                        Ok(json!({"name":attachment["name"],"contentType":attachment["contentType"],"contentBase64":attachment["contentBase64"]}))
                    })
                    .collect::<Result<Vec<_>, Error>>()?;
                let mut body = json!({"managed":true,"conversationId":conversation,"previousRunId":cursor.previous_run_id,"message":message,"attachments":attachments,"deadline":cursor.deadline_ms});
                if let Some(proof) = &cursor.conversation {
                    body["expectedGeneration"] = json!(proof.generation);
                }
                (base.clone(), body, 0, None)
            }
            OpenDelivery::Recover { input_generation } => {
                if input_generation > SAFE_INTEGER {
                    return Err(FAILED);
                }
                (
                    format!("{base}/recover"),
                    json!({"managed":true,"inputGeneration":input_generation}),
                    input_generation,
                    None,
                )
            }
            OpenDelivery::Activate { plan } => {
                if !plan_valid(&plan)
                    || plan.activation_run_id != run
                    || plan.conversation.conversation_id != conversation
                    || self.context.model["provider"] != plan.authority.provider
                    || self.context.model["modelId"] != plan.authority.model_id
                    || self.context.reasoning_effort != plan.authority.reasoning_effort
                {
                    return Err(FAILED);
                }
                (
                    format!("{base}/handoffs/{}/activate", plan.id),
                    json!({"boundary":plan.boundary}),
                    plan.conversation
                        .generation
                        .checked_add(1)
                        .filter(|generation| *generation <= SAFE_INTEGER)
                        .ok_or(FAILED)?,
                    Some(plan.id),
                )
            }
        };
        self.token = self.runtime.0.transport.channel(&self.context, false)?;
        // A lost first admission keeps enough cursor context to retry the exact
        // start. No managed request owns the live feed before its receipt and
        // application checkpoint have both been accepted.
        if starting {
            self.context.checkpoint.save(cursor.encode()).await?;
        }
        let acknowledged = match self
            .runtime
            .post(
                &path,
                &self.token,
                body,
                self.context.correlation_id.as_deref(),
                &self.context.run_id,
            )
            .await
        {
            Ok(value) => value,
            Err(failure) => {
                if starting && matches!(failure, PostFailure::Rejected(_)) {
                    self.restore_checkpoint(prior_checkpoint.as_deref()).await?;
                }
                return Err(FAILED);
            }
        };
        let receipt: DeliveryReceipt =
            serde_json::from_value(acknowledged["delivery"].clone()).map_err(|_| FAILED)?;
        if receipt.run_id != run
            || receipt.input_generation != generation
            || receipt.stream_start_index > SAFE_INTEGER
            || (!recovering && receipt.handoff_id != handoff)
        {
            return Err(FAILED);
        }
        if !receipt.current_delivery {
            if starting {
                self.restore_checkpoint(prior_checkpoint.as_deref()).await?;
            }
            self.admission = Some(receipt);
            self.done = true;
            return Ok(());
        }
        let status = acknowledged.get("status").ok_or(FAILED)?;
        cursor.accept_conversation(status)?;
        let boundary = status_boundary(status, &cursor, generation)?;
        cursor.stream_index = if recovering || starting {
            cursor.stream_index.max(receipt.stream_start_index)
        } else {
            receipt.stream_start_index
        };
        if cursor.stream_index > boundary.delivery.next_index {
            return Err(FAILED);
        }
        cursor.admitted = true;
        cursor.settled = None;
        cursor.pending_inputs = false;
        cursor.delivery_complete = false;
        self.context.checkpoint.save(cursor.encode()).await?;
        self.claim()?;
        self.owned()?;
        let response = timeout(
            Duration::from_secs(30),
            self.runtime.0.transport.request(
                &format!(
                    "{base}/stream?after={}&inputGeneration={generation}",
                    cursor.stream_index
                ),
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
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| {
                    value.split(';').next().is_some_and(|media_type| {
                        media_type
                            .trim()
                            .eq_ignore_ascii_case("application/x-ndjson")
                    })
                })
        {
            return Err(FAILED);
        }
        self.admission = Some(receipt);
        self.cursor = Some(cursor);
        self.response = Some(response);
        Ok(())
    }
    async fn restore_checkpoint(&self, previous: Option<&str>) -> Result<(), Error> {
        if let Some(previous) = previous {
            self.context.checkpoint.save(previous.to_owned()).await
        } else {
            self.context.checkpoint.clear().await
        }
    }
    async fn next(&mut self) -> Result<Option<Value>, Error> {
        if let Some(mode) = self.mode.take() {
            self.initialize(mode).await?;
            if self.done {
                return Ok(None);
            }
        }
        if self.done && self.queue.is_empty() && !self.pending_checkpoint {
            return Ok(None);
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
                            && !(self.managed && status["phase"] == "cancelled")
                        || status["nextIndex"].as_u64() != Some(cursor.stream_index)
                    {
                        return Err(FAILED);
                    }
                    cursor.accept_conversation(status)?;
                    let boundary = if self.managed {
                        Some(status_boundary(
                            status,
                            cursor,
                            self.admission.as_ref().ok_or(FAILED)?.input_generation,
                        )?)
                    } else {
                        None
                    };
                    let pending = status.get("pendingRequests").and_then(Value::as_array);
                    let requests = pending.filter(|requests| !requests.is_empty());
                    let questions = requests.is_some_and(|requests| {
                        requests.iter().all(|request| request["kind"] == "question")
                    });
                    let mut question_events = vec![];
                    if let Some(requests) = requests {
                        if (status["cancelled"] == true
                            && boundary.as_ref().is_none_or(|boundary| {
                                boundary.execution.run_id == boundary.delivery.run_id
                                    || boundary.execution.cancelled
                            }))
                            || requests
                                .iter()
                                .any(|request| match request["kind"].as_str() {
                                    Some("question") => {
                                        request["action"]["toolName"] != "ask_question"
                                            || !matches!(
                                                request["display"].as_str(),
                                                Some("text" | "select")
                                            )
                                    }
                                    Some("tool-approval" | "session-limit") => {
                                        request["display"] != "confirmation"
                                            || request["requestId"]
                                                .as_str()
                                                .is_none_or(|id| Uuid::parse_str(id).is_err())
                                    }
                                    _ => true,
                                })
                        {
                            return Err(FAILED);
                        }
                        let normalized = eve::normalize(
                            json!({"type":"input.requested","data":{"requests":requests}}),
                            &format!("native:{}", cursor.run_id),
                            Some(cursor.stream_index as f64),
                        )
                        .map_err(|_| FAILED)?;
                        if questions {
                            question_events = normalized
                                .into_iter()
                                .map(|event| {
                                    forge_core::agents::presentation::native_event(event)
                                        .map_err(|_| FAILED)
                                })
                                .collect::<Result<Vec<_>, _>>()?;
                        }
                    }
                    cursor.delivery_complete = status["deliveryComplete"]
                        .as_bool()
                        .unwrap_or(status["phase"] == "complete");
                    cursor.pending_inputs = requests.is_some();
                    cursor.settled = if status["cancelled"] == true || status["phase"] == "failed" {
                        None
                    } else if questions {
                        Some(Settled::Questions)
                    } else if requests.is_some() {
                        Some(Settled::Inputs)
                    } else if cursor.delivery_complete {
                        Some(Settled::Complete)
                    } else {
                        None
                    };
                    // A managed consumer commits the final cursor together with
                    // its terminal/pending application state. The adapter must
                    // never certify a drain ahead of that atomic app commit.
                    if let Some(boundary) = boundary {
                        self.parked = Some(DeliveryFrame::Parked {
                            boundary,
                            final_cursor: cursor.encode(),
                        });
                    } else {
                        self.context.checkpoint.save(cursor.encode()).await?;
                    }
                    let kind = if status["cancelled"] == true
                        || (self.managed && status["phase"] == "cancelled")
                    {
                        Some("run.cancelled")
                    } else if status["phase"] == "failed" {
                        Some("run.failed")
                    } else if cursor.delivery_complete {
                        Some("run.completed")
                    } else {
                        match status["phase"].as_str() {
                            Some("complete") => Some("run.completed"),
                            Some("failed") => Some("run.failed"),
                            _ => None,
                        }
                    };
                    let delivery_key = if self.managed {
                        format!(
                            "delivery:{}",
                            self.admission.as_ref().ok_or(FAILED)?.input_generation
                        )
                    } else {
                        self.owner.to_string()
                    };
                    if let Some(kind) = kind {
                        if self.managed || !self.terminal_seen {
                            let source = if self.managed {
                                format!("native:{}:{delivery_key}:status:{kind}", cursor.run_id)
                            } else {
                                format!("native:{}:status:{kind}", cursor.run_id)
                            };
                            self.queue.push_back(json!({"sourceEventId":source,"source":"eve","type":kind,"payload":if kind=="run.failed"{json!({"code":"RUNTIME_EXECUTION_FAILED","message":"The native runtime run failed."})}else{json!({})}}));
                        }
                    } else if self.managed || !self.waiting_seen {
                        if !self.waiting_seen && !question_events.is_empty() {
                            for (index, event) in question_events.iter_mut().enumerate() {
                                event["sourceEventId"] = json!(format!(
                                    "native:{}:waiting:{}:{index}",
                                    cursor.run_id, delivery_key
                                ));
                            }
                            self.queue.extend(question_events);
                            if !self.managed {
                                self.done = true;
                                continue;
                            }
                        }
                        let request = requests
                            .and_then(|requests| {
                                requests.iter().find(|request| {
                                    matches!(
                                        request["kind"].as_str(),
                                        Some("tool-approval" | "session-limit")
                                    )
                                })
                            })
                            .and_then(|request| request["requestId"].as_str())
                            .or_else(|| {
                                self.managed
                                    .then(|| requests?.first()?["requestId"].as_str())
                                    .flatten()
                            })
                            .or_else(|| status["pendingRequestId"].as_str())
                            .filter(|v| Uuid::parse_str(v).is_ok())
                            .ok_or(FAILED)?;
                        // A fresh stream may start after the approval event's
                        // offset. Reassert waiting for the coordinator's current
                        // recovery epoch without requesting another approval.
                        self.queue.push_back(json!({"sourceEventId":format!("native:{}:waiting:{}",cursor.run_id,delivery_key),"source":"eve","type":"run.waiting","payload":{"reason":"input-required","requestId":request}}));
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
    fn supports_delivery_queue(&self) -> bool {
        true
    }
    async fn enqueue_input(
        &self,
        context: &Context,
        input: &QueuedInput,
    ) -> Result<IntentReceipt, Error> {
        let run: Uuid = context.run_id.parse().map_err(|_| FAILED)?;
        if context.thread_id.parse::<Uuid>().map_err(|_| FAILED)? != input.conversation_id {
            return Err(FAILED);
        }
        let token = self.0.transport.channel(context, false)?;
        let response = self
            .post(
                &format!("/native/v1/runs/{run}/inputs"),
                &token,
                json!(input),
                context.correlation_id.as_deref(),
                &context.run_id,
            )
            .await
            .map_err(|_| FAILED)?;
        let receipt: IntentReceipt =
            serde_json::from_value(response["intent"].clone()).map_err(|_| FAILED)?;
        if receipt.intent_id != input.intent_id
            || receipt.original_run_id != run
            || receipt.request_id != input.request_id
            || receipt.approved != input.approved
            || receipt.conversation.conversation_id != input.conversation_id
            || !fence_valid(&receipt.conversation)
            || receipt.sequence > SAFE_INTEGER
            || receipt
                .stream_start_index
                .is_some_and(|index| index > SAFE_INTEGER)
        {
            return Err(FAILED);
        }
        Ok(receipt)
    }
    async fn acknowledge_drained(
        &self,
        context: &Context,
        boundary: &DrainBoundary,
    ) -> Result<(), Error> {
        if !boundary_valid(boundary)
            || context.thread_id.parse::<Uuid>().map_err(|_| FAILED)?
                != boundary.conversation.conversation_id
            || context.run_id.parse::<Uuid>().map_err(|_| FAILED)? != boundary.delivery.run_id
        {
            return Err(FAILED);
        }
        let token = self.0.transport.channel(context, false)?;
        self.post(
            &format!(
                "/native/v1/conversations/{}/drained",
                boundary.conversation.conversation_id
            ),
            &token,
            json!({"boundary":boundary}),
            context.correlation_id.as_deref(),
            &context.run_id,
        )
        .await
        .map_err(|_| FAILED)?;
        Ok(())
    }
    async fn prepare_handoff(
        &self,
        context: &Context,
        fence: &ConversationFence,
    ) -> Result<Preparation, Error> {
        if !fence_valid(fence)
            || context.thread_id.parse::<Uuid>().map_err(|_| FAILED)? != fence.conversation_id
            || Uuid::parse_str(&context.run_id).is_err()
        {
            return Err(FAILED);
        }
        let token = self.0.transport.channel(context, false)?;
        let response = self
            .post(
                &format!(
                    "/native/v1/conversations/{}/handoffs/prepare",
                    fence.conversation_id
                ),
                &token,
                json!({"fence":fence}),
                context.correlation_id.as_deref(),
                &context.run_id,
            )
            .await
            .map_err(|_| FAILED)?;
        let preparation: Preparation =
            serde_json::from_value(response["preparation"].clone()).map_err(|_| FAILED)?;
        if let Preparation::Ready { plan } = &preparation
            && (!plan_valid(plan) || &plan.conversation != fence)
        {
            return Err(FAILED);
        }
        Ok(preparation)
    }
    async fn open_delivery(
        &self,
        context: Context,
        delivery: OpenDelivery,
    ) -> Result<ManagedSession, Error> {
        let mut state = self.state(context, Mode::Managed(delivery), true);
        let mode = state.mode.take().ok_or(FAILED)?;
        state.initialize(mode).await?;
        let admission = state.admission.clone().ok_or(FAILED)?;
        let frames = Box::pin(futures_util::stream::try_unfold(
            state,
            |mut state| async move {
                if let Some(event) = state.next().await? {
                    return Ok(Some((DeliveryFrame::Event(event), state)));
                }
                if let Some(parked) = state.parked.take() {
                    state.owned()?;
                    return Ok(Some((parked, state)));
                }
                Ok(None)
            },
        ));
        Ok(ManagedSession { admission, frames })
    }
    fn cursor_run_id(&self, cursor: &str) -> Option<String> {
        Some(Cursor::decode(cursor)?.run_id.to_string())
    }
    fn question_continuation_run(&self, cursor: &str, terminal: bool) -> Option<String> {
        let cursor = Cursor::decode(cursor)?;
        (matches!(cursor.settled, Some(Settled::Questions)) || (terminal && cursor.admitted))
            .then(|| cursor.run_id.to_string())
    }
    fn input_continuation(&self, cursor: &str) -> Option<Continuation> {
        let cursor = Cursor::decode(cursor)?;
        if !cursor.admitted {
            return None;
        }
        let proof = cursor.conversation?;
        Some(Continuation {
            head_run_id: proof.head_run_id.to_string(),
            owner_run_id: proof.owner_run_id.to_string(),
            pending_inputs: cursor.settled.is_some() && cursor.pending_inputs,
            delivery_complete: cursor.settled.is_some() && cursor.delivery_complete,
        })
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
