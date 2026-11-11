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
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;
use url::Url;
pub const SECRET: &str = "public-native-adapter-fixture-signing-secret";
#[derive(Clone, Copy)]
pub enum Mode {
    Finish,
    Approve,
    Stall,
}
pub struct Script {
    mode: Mode,
    pub models: AtomicUsize,
    pub effects: AtomicUsize,
    pub began: Notify,
}
struct Adapter(Arc<Script>);
#[async_trait]
impl Model for Adapter {
    async fn generate(
        &self,
        _: &Channel,
        turn: Turn<'_>,
        _: &Cancellation,
        _: &mut dyn Sink,
    ) -> Result<Completion> {
        self.0.models.fetch_add(1, Ordering::SeqCst);
        self.0.began.notify_one();
        if matches!(self.0.mode, Mode::Stall) {
            std::future::pending::<()>().await;
        }
        let approval = matches!(self.0.mode, Mode::Approve)
            && !turn.prompt.iter().any(|v| v["role"] == "tool");
        Ok(Completion {
            content: if approval {
                vec![
                    json!({"type":"tool-call","toolCallId":"change-team","toolName":"update_team","input":{"slug":"forge","settings":{"name":"Changed"}}}),
                ]
            } else {
                vec![json!({"type":"text","text":"The marker is marigold."})]
            },
            finish: if approval {
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
        Ok(Engine::new(
            Arc::new(Adapter(self.0.clone())),
            Arc::new(Executor {
                capabilities: Arc::new(Adapter(self.0.clone())),
                sandbox: None,
                features: Features::default(),
            }),
        ))
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
