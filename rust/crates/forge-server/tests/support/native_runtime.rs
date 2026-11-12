use async_trait::async_trait;
use forge_agent_runtime::{
    Result,
    auth::Channel,
    callback::{Capabilities, Request},
    engine::{Engine, State},
    execution::Features,
    host::Host,
    http,
    journal::Store,
    model::{
        stream::{Completion, Finish},
        transport::{Model, Sink, Turn},
    },
    sandbox::Cancellation,
    tools::Executor,
    worker::{Factory, Options},
};
use serde_json::{Value, json};
use sqlx::postgres::PgPoolOptions;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;
use url::Url;
pub const SECRET: &str = "public-native-adapter-fixture-signing-secret";
#[derive(Clone, Copy)]
pub enum Mode {
    Finish,
    Search,
    Budget,
    Approve,
    Questions,
    Stall,
    LargeToolData,
    SensitiveToolData,
}
pub struct Script {
    mode: Mode,
    pub models: AtomicUsize,
    pub effects: AtomicUsize,
    pub output_limits: Mutex<Vec<u32>>,
    pub question_results: Mutex<Vec<Value>>,
    pub began: Notify,
}
struct Adapter(Arc<Script>);
#[async_trait]
impl Model for Adapter {
    async fn generate(
        &self,
        channel: &Channel,
        turn: Turn<'_>,
        _: &Cancellation,
        _: &mut dyn Sink,
    ) -> Result<Completion> {
        self.0.models.fetch_add(1, Ordering::SeqCst);
        self.0
            .output_limits
            .lock()
            .unwrap()
            .push(turn.max_output_tokens.unwrap());
        self.0.began.notify_one();
        if matches!(self.0.mode, Mode::Stall) {
            std::future::pending::<()>().await;
        }
        if matches!(self.0.mode, Mode::Questions) {
            let answers: Vec<Value> = turn
                .prompt
                .iter()
                .filter(|message| message["role"] == "tool")
                .filter_map(|message| message["content"].as_array())
                .flatten()
                .filter(|part| part["toolName"] == "ask_question")
                .cloned()
                .collect();
            let asking = answers.is_empty();
            self.0.question_results.lock().unwrap().extend(answers);
            return Ok(Completion {
                content: if asking {
                    vec![
                        json!({"type":"tool-call","toolCallId":"opaque-question-choice","toolName":"ask_question","input":{"prompt":"Choose a name","options":[{"id":"a","label":"Aster"},{"id":"b","label":"Marigold"}],"allowFreeform":false}}),
                        json!({"type":"tool-call","toolCallId":"opaque-question-text","toolName":"ask_question","input":{"prompt":"Why?","allowFreeform":true}}),
                    ]
                } else {
                    vec![json!({"type":"text","text":"The marker is marigold."})]
                },
                finish: if asking {
                    Finish::ToolCalls
                } else {
                    Finish::Stop
                },
                usage: json!({"inputTokens":10,"outputTokens":5}),
            });
        }
        if matches!(self.0.mode, Mode::Search) {
            let searched = turn.prompt.iter().any(|m| {
                m["content"]
                    .as_array()
                    .is_some_and(|p| p.iter().any(|p| p["toolName"] == "web_search"))
            });
            let anthropic = channel.provider() == "anthropic";
            let content = if searched {
                vec![
                    json!({"type":"text","text":"The marker is marigold.","providerOptions":{"forge":{"sources":[{"url":"https://example.com/forge","title":"Forge reference"}]}}}),
                ]
            } else {
                vec![
                    json!({"type":"tool-call","toolCallId":"search_native","toolName":"web_search","providerExecuted":true,"input":if anthropic{json!({"query":"Forge"})}else{json!({})}}),
                    json!({"type":"tool-result","toolCallId":"search_native","toolName":"web_search","output":{"type":"json","value":if anthropic{json!([{"type":"web_search_result","url":"https://example.com/forge","title":"Forge reference","pageAge":null,"encryptedContent":"fixture-private-search-content"}])}else{json!({"action":{"type":"search","query":"Forge"},"sources":[{"type":"url","url":"https://example.com/forge"}]})}}}),
                ]
            };
            return Ok(Completion {
                content,
                finish: Finish::Stop,
                usage: json!({"inputTokens":10,"outputTokens":5}),
            });
        }
        let approval = matches!(self.0.mode, Mode::Approve)
            && !turn.prompt.iter().any(|v| v["role"] == "tool");
        let tool_data = matches!(self.0.mode, Mode::LargeToolData | Mode::SensitiveToolData)
            && !turn.prompt.iter().any(|v| v["role"] == "tool");
        let content = if !tool_data {
            String::new()
        } else if matches!(self.0.mode, Mode::SensitiveToolData) {
            "Bearer fixture-credential-should-not-display".into()
        } else {
            "😀".repeat(40_000)
        };
        Ok(Completion {
            content: if tool_data {
                vec![
                    json!({"type":"tool-call","toolCallId":"save-task","toolName":"todo","input":{"todos":[{"content":content,"priority":"high","status":"pending"}]}}),
                ]
            } else if approval {
                vec![
                    json!({"type":"tool-call","toolCallId":"change-team","toolName":"update_team","input":{"slug":"forge","settings":{"name":"Changed"}}}),
                ]
            } else {
                vec![json!({"type":"text","text":"The marker is marigold."})]
            },
            finish: if approval || tool_data {
                Finish::ToolCalls
            } else {
                Finish::Stop
            },
            usage: json!({"inputTokens":10,"outputTokens":5}),
        })
    }
}
#[async_trait]
impl Capabilities for Adapter {
    async fn call(&self, channel: &Channel, request: Request) -> Result<Value> {
        assert!(!channel.run_id().is_empty());
        assert_eq!(request.id, "teams.update");
        self.0.effects.fetch_add(1, Ordering::SeqCst);
        Ok(
            json!({"id":"00000000-0000-4000-8000-000000000001","slug":"forge","identifier":"FOR","name":"Changed","timezone":"Europe/Paris","description":"Fixture"}),
        )
    }
}
#[async_trait]
impl Factory for Adapter {
    async fn create(&self, _: &Channel, _: &State, _: &Cancellation) -> Result<Engine> {
        let mut engine = Engine::new(
            Arc::new(Adapter(self.0.clone())),
            Arc::new(Executor {
                capabilities: Arc::new(Adapter(self.0.clone())),
                sandbox: None,
                features: Features::default(),
            }),
        );
        if matches!(self.0.mode, Mode::Budget) {
            engine.max_input_tokens = 10;
        }
        Ok(engine)
    }
}
pub struct Fixture {
    pub origin: Url,
    pub host: Host,
    pub store: Store,
    pub script: Arc<Script>,
    pub deliveries: Arc<AtomicUsize>,
    server: tokio::task::JoinHandle<()>,
}
impl Fixture {
    pub async fn new(mode: Mode, lose_first_ack: bool) -> Self {
        let url = std::env::var("FORGE_RUST_RUNTIME_TEST_DATABASE_URL")
            .expect("Use the disposable PostgreSQL milestone runner");
        let parsed = Url::parse(&url).unwrap();
        assert_eq!(parsed.host_str(), Some("127.0.0.1"));
        assert_eq!(parsed.path(), "/forge_rust_runtime");
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .connect(&url)
            .await
            .unwrap();
        Store::install(&pool).await.unwrap();
        let store = Store::new(pool);
        let script = Arc::new(Script {
            mode,
            models: AtomicUsize::new(0),
            effects: AtomicUsize::new(0),
            output_limits: Mutex::new(vec![]),
            question_results: Mutex::new(vec![]),
            began: Notify::new(),
        });
        let host = Host::new(
            store.clone(),
            Arc::new(Adapter(script.clone())),
            Options::default(),
            8,
            8,
        )
        .unwrap();
        let deliveries = Arc::new(AtomicUsize::new(0));
        let count = deliveries.clone();
        let app =
            http::router(host.clone(), SECRET.into())
                .unwrap()
                .layer(axum::middleware::from_fn(
                    move |request: axum::extract::Request, next: axum::middleware::Next| {
                        let count = count.clone();
                        async move {
                            let admission = request.method() == axum::http::Method::POST
                                && request.uri().path().split('/').count() == 5;
                            let mut response = next.run(request).await;
                            if admission
                                && count.fetch_add(1, Ordering::SeqCst) == 0
                                && lose_first_ack
                            {
                                *response.body_mut() = axum::body::Body::from("{");
                            }
                            response
                        }
                    },
                ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            origin,
            host,
            store,
            script,
            deliveries,
            server,
        }
    }
    pub fn options(&self) -> forge_server::agent_runtime::Options {
        forge_server::agent_runtime::Options {
            base_url: self.origin.clone(),
            channel_secret: SECRET.into(),
            capability_secret: SECRET.into(),
            model_secret: SECRET.into(),
            peer_origin: None,
            peer_identity: None,
            now: Arc::new(|| chrono::Utc::now().timestamp()),
        }
    }
    pub async fn shutdown(&self) {
        self.host.shutdown().await.unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
