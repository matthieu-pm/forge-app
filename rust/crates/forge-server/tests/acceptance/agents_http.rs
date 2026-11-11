use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use forge_core::{
    actor::Actor,
    agents::{
        providers,
        runtime::{self, Runtime},
    },
};
use forge_store::agents::{
    coordinator::{CODEX_LOCAL_CONNECTION_ID, Hosted, Service},
    model_connections,
};
use futures_util::StreamExt;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Provider;
#[async_trait]
impl providers::Discovery for Provider {
    async fn validate_endpoint(&self, _: &str) -> Result<String, providers::Error> {
        Err(providers::Error::new(
            providers::Code::InvalidEndpoint,
            "Invalid endpoint.",
        ))
    }
    async fn discover(
        &self,
        _: &providers::DiscoveryInput,
    ) -> Result<Vec<providers::Model>, providers::Error> {
        Ok(providers::normalize(
            "openai",
            Some(&json!({"data":[{"id":"gpt-5"}]})),
            &[],
        ))
    }
}
#[derive(Default)]
struct RuntimeFixture(AtomicUsize);
#[async_trait]
impl Runtime for RuntimeFixture {
    fn kind(&self) -> &'static str {
        "eve"
    }
    fn start(&self, _: runtime::Context, _: String, _: Vec<Value>) -> runtime::Events {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(futures_util::stream::iter([Ok(
            json!({"sourceEventId":"http:delta","source":"eve","type":"assistant.delta","payload":{"messageId":"answer","delta":"Hello"}}),
        )]))
    }
    fn resume(&self, c: runtime::Context, _: Vec<Value>) -> runtime::Events {
        self.start(c, String::new(), vec![])
    }
    fn reconnect(&self, _: runtime::Context) -> runtime::Events {
        Box::pin(futures_util::stream::empty())
    }
    async fn cancel(
        &self,
        _: &str,
        _: Option<&str>,
        _: Option<&runtime::Context>,
    ) -> Result<(), runtime::Error> {
        Ok(())
    }
}
struct AgentFixture {
    f: Fixture,
    cookie: String,
    actor: Actor,
    service: Service,
    models: Arc<model_connections::Service>,
    runtime: Arc<RuntimeFixture>,
    dir: std::path::PathBuf,
}
impl Drop for AgentFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
impl AgentFixture {
    async fn new() -> Self {
        let f = Fixture::new().await;
        let (_, token, cookie) = f.account().await;
        forge_store::workspaces::create(
            &f.database,
            &token,
            "Agent HTTP",
            &Uuid::new_v4().to_string(),
            None,
        )
        .await
        .unwrap();
        let actor = forge_store::authority::session_actor(&f.database, &token)
            .await
            .unwrap();
        let vault =
            Arc::new(forge_identity::model_vault::Vault::new(&STANDARD.encode([4; 32])).unwrap());
        let models = Arc::new(model_connections::Service::new(
            f.database.clone(),
            Arc::new(Provider),
            vault,
        ));
        models.create(&actor,json!({"provider":"openai","scope":"personal","displayName":"Test provider","apiKey":"fixture-key"})).await.unwrap();
        let runtime = Arc::new(RuntimeFixture::default());
        let mut service = Service::new(f.database.clone());
        service.hosted = Some(Arc::new(Hosted::new(models.clone(), vec![runtime.clone()])));
        let dir = std::env::temp_dir().join(format!("forge-agents-http-{}", Uuid::new_v4()));
        let storage = forge_server::files::storage::Storage::local(&dir).unwrap();
        service.attachments = Some(Arc::new(forge_store::agents::files::Service::new(
            f.database.clone(),
            Arc::new(storage),
        )));
        let mut result = Self {
            f,
            cookie,
            actor,
            service,
            models,
            runtime,
            dir,
        };
        result.configure(&[]);
        result
    }
    fn configure(&mut self, disabled: &[&str]) {
        let mut settings =
            forge_server::agents::Settings::new(self.service.clone(), self.models.clone());
        settings.local_secret = SECRET.into();
        settings.artifact_secret = SECRET.into();
        settings.capability_secret = SECRET.into();
        for flag in disabled {
            settings.features[*flag] = json!(false);
        }
        self.f.app = forge_server::router_with_state(
            AppState::configured_database(
                self.f.database.clone(),
                AuthSettings::new(SECRET.into(), ORIGIN).unwrap(),
                None,
            )
            .with_agents(settings),
        );
    }
    async fn thread(&self) -> String {
        let (s, _, v) = self
            .f
            .request(
                "POST",
                "/api/agent/threads",
                Some(&self.cookie),
                Some(json!({})),
            )
            .await;
        assert_eq!(s, StatusCode::CREATED, "{v}");
        v["id"].as_str().unwrap().into()
    }
    fn local(thread: &str) -> Value {
        json!({"threadId":thread,"runtimeId":"codex","message":"Hello","model":{"selectionId":"local:codex:gpt-codex","connectionId":CODEX_LOCAL_CONNECTION_ID,"executionKind":"external-agent","provider":"openai","modelId":"gpt-codex"}})
    }
    async fn local_run(&self, thread: &str) -> Value {
        let (s, _, v) = self
            .f
            .request(
                "POST",
                "/api/agent/local-runs",
                Some(&self.cookie),
                Some(Self::local(thread)),
            )
            .await;
        assert_eq!(s, StatusCode::CREATED, "{v}");
        v
    }
    async fn raw(
        &self,
        method: &str,
        path: &str,
        cookie: Option<&str>,
        headers: &[(&str, &str)],
        body: Body,
    ) -> axum::response::Response {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(cookie) = cookie {
            request = request.header("cookie", cookie);
        }
        for (key, value) in headers {
            request = request.header(*key, *value);
        }
        self.f
            .app
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap()
    }
}
async fn value(response: axum::response::Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn agent_http_session_origin_feature_and_private_thread_boundaries() {
    let mut f = AgentFixture::new().await;
    assert_eq!(
        f.f.request("GET", "/api/agent/threads", None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    let r = f
        .raw(
            "POST",
            "/api/agent/threads",
            Some(&f.cookie),
            &[],
            Body::from("{}"),
        )
        .await;
    assert_eq!(value(r).await.1["error"]["code"], "INVALID_ORIGIN");
    let r = f
        .raw(
            "POST",
            "/api/agent/threads",
            Some(&f.cookie),
            &[
                ("origin", "https://other.invalid"),
                ("electron-origin", ORIGIN),
            ],
            Body::from("{}"),
        )
        .await;
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    let thread = f.thread().await;
    let other = f.f.account().await;
    let (_, _, workspace) =
        f.f.request("GET", "/api/agent/threads", Some(&f.cookie), None)
            .await;
    assert_eq!(workspace.as_array().unwrap().len(), 1);
    assert_eq!(
        f.f.request(
            "GET",
            &format!("/api/agent/threads/{thread}/events"),
            Some(&other.2),
            None
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (s, _, renamed) =
        f.f.request(
            "PATCH",
            &format!("/api/agent/threads/{thread}"),
            Some(&f.cookie),
            Some(json!({"action":"rename","title":" New name "})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(renamed["title"], "New name");
    assert_eq!(
        f.f.request(
            "PATCH",
            &format!("/api/agent/threads/{thread}"),
            Some(&f.cookie),
            Some(json!({"action":"archive","extra":true}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    f.configure(&["agent_ui"]);
    assert_eq!(
        f.f.request("GET", "/api/agent/features", Some(&f.cookie), None)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        f.f.request("GET", "/api/agent/threads", None, None).await.0,
        StatusCode::NOT_FOUND
    );
    f.configure(&["agent_codex_local", "agent_model_connections"]);
    for path in [
        "/api/agent/local-runs",
        "/api/agent/models",
        "/api/agent/connections",
    ] {
        assert_eq!(
            f.f.request("GET", path, None, None).await.0,
            StatusCode::NOT_FOUND
        );
    }
}
#[tokio::test]
async fn local_http_requires_session_and_exact_token_and_persists_checkpoints_and_usage() {
    let f = AgentFixture::new().await;
    let thread = f.thread().await;
    let run = f.local_run(&thread).await;
    let id = run["run"]["id"].as_str().unwrap();
    let token = format!("Bearer {}", run["ingestToken"].as_str().unwrap());
    assert!(run.get("thread").is_none());
    assert!(run.get("ingestToken").is_some());
    let checkpoint = json!({"runtimeSessionId":Uuid::new_v4(),"runtimeRunId":Uuid::new_v4()});
    let path = format!("/api/agent/local-runs/{id}");
    for headers in [
        vec![("origin", ORIGIN)],
        vec![("origin", ORIGIN), ("authorization", "Bearer bad")],
    ] {
        let r = f
            .raw(
                "PATCH",
                &path,
                Some(&f.cookie),
                &headers,
                Body::from(checkpoint.to_string()),
            )
            .await;
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    }
    let headers = [("origin", ORIGIN), ("authorization", token.as_str())];
    let r = f
        .raw(
            "PATCH",
            &path,
            None,
            &headers,
            Body::from(checkpoint.to_string()),
        )
        .await;
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    let r = f
        .raw(
            "PATCH",
            &path,
            Some(&f.cookie),
            &headers,
            Body::from(checkpoint.to_string()),
        )
        .await;
    assert_eq!(value(r).await, (StatusCode::OK, json!({"ok":true})));
    let other = f.local_run(&f.thread().await).await;
    let wrong = format!(
        "/api/agent/local-runs/{}",
        other["run"]["id"].as_str().unwrap()
    );
    let r = f
        .raw(
            "PATCH",
            &wrong,
            Some(&f.cookie),
            &headers,
            Body::from(checkpoint.to_string()),
        )
        .await;
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    let event = json!({"runId":id,"events":[{"sourceEventId":"usage","source":"codex","type":"run.usage","occurredAt":"2026-11-11T12:00:00Z","payload":{"inputTokens":12,"costMicros":5}}]});
    for _ in 0..2 {
        let r = f
            .raw(
                "POST",
                "/api/agent/local-ingest",
                Some(&f.cookie),
                &headers,
                Body::from(event.to_string()),
            )
            .await;
        assert_eq!(r.status(), StatusCode::OK);
    }
    let run =
        forge_store::agents::runs::get(&f.f.database, &f.actor.workspace_id, id.parse().unwrap())
            .await
            .unwrap()
            .unwrap();
    assert_eq!((run.input_tokens, run.cost_micros), (12, 5));
    let r = f
        .raw(
            "POST",
            "/api/agent/local-tool-calls",
            Some(&f.cookie),
            &headers,
            Body::from(
                json!({"runId":id,"namespace":"forge","tool":"workspace_describe","arguments":{}})
                    .to_string(),
            ),
        )
        .await;
    let (s, result) = value(r).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(result["success"], true);
    let (s, _, events) =
        f.f.request(
            "GET",
            &format!("/api/agent/runs/{id}/events?after=0x3"),
            Some(&f.cookie),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(events.as_array().unwrap().len(), 1);
    assert_eq!(
        f.f.request(
            "GET",
            &format!("/api/agent/runs/{id}/events?after=-1"),
            Some(&f.cookie),
            None
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.f.request(
            "DELETE",
            &format!("/api/agent/runs/{id}"),
            Some(&f.cookie),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    let r = f
        .raw(
            "POST",
            "/api/agent/local-tool-calls",
            Some(&f.cookie),
            &headers,
            Body::from(
                json!({"runId":id,"namespace":"forge","tool":"workspace_describe","arguments":{}})
                    .to_string(),
            ),
        )
        .await;
    assert_eq!(value(r).await.1["success"], false);
}
#[tokio::test]
async fn hosted_http_stream_is_lazy_framed_and_reauthorizes_each_emission() {
    for revoke in [false, true] {
        let f = AgentFixture::new().await;
        let thread = f.thread().await;
        let model = f.models.catalog(&f.actor, true).await.unwrap().remove(0);
        let input = json!({"threadId":thread,"message":"Hello","selectionMode":"auto","preferredOpenAIConnectionId":model["connectionId"]});
        let response = f
            .raw(
                "POST",
                "/api/agent/runs",
                Some(&f.cookie),
                &[("origin", ORIGIN)],
                Body::from(input.to_string()),
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()["content-type"],
            "text/event-stream; charset=utf-8"
        );
        assert_eq!(response.headers()["x-accel-buffering"], "no");
        assert_eq!(f.runtime.0.load(Ordering::SeqCst), 0);
        let mut stream = response.into_body().into_data_stream();
        let first = String::from_utf8(stream.next().await.unwrap().unwrap().to_vec()).unwrap();
        assert!(first.starts_with("id: 1\nevent: run.created\ndata: "));
        if revoke {
            sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
                .bind(&f.actor.workspace_id)
                .bind(&f.actor.user_id)
                .execute(&f.f.pool)
                .await
                .unwrap();
            let frame = stream.next().await.unwrap().unwrap();
            assert!(String::from_utf8_lossy(&frame).starts_with("event: transport.error\n"));
            assert!(stream.next().await.is_none());
            assert_eq!(f.runtime.0.load(Ordering::SeqCst), 0);
        } else {
            let mut frames = Vec::new();
            while let Some(frame) = stream.next().await {
                frames.push(String::from_utf8(frame.unwrap().to_vec()).unwrap());
            }
            assert_eq!(frames.len(), 4);
            assert!(frames.last().unwrap().contains("event: run.completed\n"));
            assert_eq!(f.runtime.0.load(Ordering::SeqCst), 1);
        }
    }
}
#[tokio::test]
async fn model_http_connections_refresh_test_delete_and_preferences_preserve_contract() {
    let f = AgentFixture::new().await;
    let thread = f.thread().await;
    let (s, _, models) =
        f.f.request("GET", "/api/agent/models", Some(&f.cookie), None)
            .await;
    assert_eq!(s, StatusCode::OK);
    let connection = models[0]["connectionId"].as_str().unwrap();
    let preference = json!({"mode":"auto","selectedConnectionId":connection,"selectedModelId":null,"selectedEffort":"high"});
    let (s, _, v) =
        f.f.request(
            "PUT",
            &format!("/api/agent/threads/{thread}/preferences"),
            Some(&f.cookie),
            Some(preference),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["selectedConnectionId"], connection);
    for action in ["refresh", "test"] {
        let (s, _, v) =
            f.f.request(
                "POST",
                &format!("/api/agent/connections/{connection}"),
                Some(&f.cookie),
                Some(json!({"action":action})),
            )
            .await;
        assert_eq!(s, StatusCode::OK, "{v}");
    }
    let (s, _, list) =
        f.f.request("GET", "/api/agent/connections", Some(&f.cookie), None)
            .await;
    assert_eq!(s, StatusCode::OK);
    assert!(!list.to_string().contains("fixture-key"));
    assert!(list[0].get("secretReference").is_none());
    assert_eq!(
        f.f.request(
            "DELETE",
            &format!("/api/agent/connections/{connection}"),
            Some(&f.cookie),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, _, v) =
        f.f.request(
            "GET",
            &format!("/api/agent/threads/{thread}/preferences"),
            Some(&f.cookie),
            None,
        )
        .await;
    assert!(v["selectedConnectionId"].is_null());
    assert_eq!(
        f.f.request(
            "POST",
            "/api/agent/attachments",
            Some(&f.cookie),
            Some(json!({}))
        )
        .await
        .0,
        StatusCode::GONE
    );
}
#[tokio::test]
async fn local_http_approval_is_canonical_and_streams_the_resolution() {
    let f = AgentFixture::new().await;
    let thread = f.thread().await;
    let run = f.local_run(&thread).await;
    let run = run["run"]["id"].as_str().unwrap().parse().unwrap();
    let approval = forge_store::agents::approval_service::Service::new(f.f.database.clone())
        .request(
            &f.actor,
            &forge_store::agents::approval_service::Request {
                approval_id: None,
                run_id: run,
                capability_id: "teams.update".into(),
                capability_version: "1".into(),
                risk: forge_store::agents::Risk::ReversibleWrite,
                input: json!({}),
                redacted_input_summary: json!({"summary":"Update"}),
                expires_at: None,
            },
        )
        .await
        .unwrap();
    let r = f
        .raw(
            "POST",
            &format!("/api/agent/approvals/{}", approval.approval.id),
            Some(&f.cookie),
            &[("origin", ORIGIN)],
            Body::from("{\"decision\":\"denied\"}"),
        )
        .await;
    assert_eq!(r.status(), StatusCode::OK);
    let data = r.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8_lossy(&data);
    assert!(text.contains("event: approval.resolved\n"));
    assert!(text.contains("\"decision\":\"denied\""));
    assert_eq!(text.matches("\ndata: ").count(), 1);
}
#[tokio::test]
async fn artifact_http_uses_bound_grants_and_inert_download_headers() {
    let f = AgentFixture::new().await;
    let thread = f.thread().await;
    let run = f.local_run(&thread).await;
    let run = run["run"]["id"].as_str().unwrap().parse().unwrap();
    let artifact=f.service.attachments.as_ref().unwrap().create_artifact(&f.actor,run,json!({"kind":"file","name":"answer.html","contentType":"text/html","content":"<script>private()</script>","encoding":"utf8"})).await.unwrap();
    let id = artifact["id"].as_str().unwrap();
    let (s, _, download) =
        f.f.request(
            "GET",
            &format!("/api/agent/artifacts/{id}"),
            Some(&f.cookie),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let url = download["downloadUrl"].as_str().unwrap();
    let r = f.raw("GET", url, None, &[], Body::empty()).await;
    assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
    let r = f.raw("GET", url, Some(&f.cookie), &[], Body::empty()).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()["content-type"], "application/octet-stream");
    assert_eq!(r.headers()["x-content-type-options"], "nosniff");
    assert!(
        r.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("sandbox")
    );
    assert_eq!(
        r.into_body().collect().await.unwrap().to_bytes(),
        "<script>private()</script>"
    );
    let r = f
        .raw(
            "GET",
            &url.replace(id, &Uuid::new_v4().to_string()),
            Some(&f.cookie),
            &[],
            Body::empty(),
        )
        .await;
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn capability_http_uses_only_bound_live_tokens_and_preserves_gateway_errors() {
    use forge_core::agents::tokens::{self, Kind};
    let mut f = AgentFixture::new().await;
    let run = f.local_run(&f.thread().await).await;
    let run = run["run"]["id"].as_str().unwrap();
    let path = "/api/agent/capabilities/workspace.describe";
    assert_eq!(
        f.raw("GET", path, None, &[], Body::empty()).await.status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    let r = f
        .raw(
            "POST",
            path,
            Some(&f.cookie),
            &[("origin", ORIGIN)],
            Body::from("{}"),
        )
        .await;
    assert_eq!(value(r).await.1["error"]["code"], "UNAUTHORIZED");
    let claims = tokens::capability_claims(
        &f.actor,
        run,
        &Uuid::new_v4().to_string(),
        &["workspace.describe".into()],
    );
    let token = tokens::mint(
        SECRET,
        Kind::Capability,
        claims,
        chrono::Utc::now().timestamp(),
        900.,
    )
    .unwrap();
    let bearer = format!("Bearer {token}");
    let headers = [
        ("authorization", bearer.as_str()),
        ("x-forge-agent-run-id", run),
        ("x-forge-workspace-id", f.actor.workspace_id.as_str()),
    ];
    let r = f
        .raw(
            "POST",
            path,
            None,
            &headers,
            Body::from("{\"version\":\"1\",\"input\":{}}"),
        )
        .await;
    let (s, v) = value(r).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert!(!v.to_string().contains(&token));
    let r = f
        .raw(
            "POST",
            "/api/agent/capabilities/teams.list",
            None,
            &headers,
            Body::from("{\"version\":\"1\",\"input\":{}}"),
        )
        .await;
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    let r = f
        .raw("POST", path, None, &headers, Body::from("{not-json-secret"))
        .await;
    let (s, v) = value(r).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert!(!v.to_string().contains("secret"));
    f.service
        .cancel_run(&f.actor, run.parse().unwrap())
        .await
        .unwrap();
    let r = f
        .raw(
            "POST",
            path,
            None,
            &headers,
            Body::from("{\"version\":\"1\",\"input\":{}}"),
        )
        .await;
    let (s, v) = value(r).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"]["code"], "FORBIDDEN");
    f.configure(&["agent_write_tools"]);
    assert_eq!(
        f.raw(
            "POST",
            "/api/agent/capabilities/teams.update",
            None,
            &[],
            Body::empty()
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn diagnostics_http_is_current_admin_only_and_contains_aggregates_without_chat_data() {
    let f = AgentFixture::new().await;
    let run = f.local_run(&f.thread().await).await;
    let id = run["run"]["id"].as_str().unwrap();
    f.service.ingest_local(&f.actor,id.parse().unwrap(),json!([{"sourceEventId":"diagnostic-usage","source":"codex","type":"run.usage","occurredAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"payload":{"inputTokens":15,"outputTokens":4,"costMicros":12}},{"sourceEventId":"diagnostic-private","source":"codex","type":"assistant.delta","occurredAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"payload":{"delta":"private sensitive chat text"}}])).await.unwrap();
    let (s, _, v) =
        f.f.request(
            "GET",
            "/api/agent/diagnostics?days=30",
            Some(&f.cookie),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["runs"]["total"], 1);
    assert_eq!(v["usage"]["costMicros"], 12);
    assert_eq!(v["usage"]["inputTokens"], 15);
    assert!(!v.to_string().contains("private sensitive chat text"));
    assert!(!v.to_string().contains(&f.actor.user_id));
    for days in ["0", "91", "1.5", "NaN"] {
        assert_eq!(
            f.f.request(
                "GET",
                &format!("/api/agent/diagnostics?days={days}"),
                Some(&f.cookie),
                None
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2")
        .bind(&f.actor.workspace_id)
        .bind(&f.actor.user_id)
        .execute(&f.f.pool)
        .await
        .unwrap();
    assert_eq!(
        f.f.request("GET", "/api/agent/diagnostics", Some(&f.cookie), None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn configured_agent_services_start_fixture_turns_without_provider_network_calls() {
    let mut f = AgentFixture::new().await;
    let env = std::collections::HashMap::from([
        ("FORGE_AGENT_LOCAL_INGEST_SECRET".into(), SECRET.into()),
        ("FORGE_AGENT_CAPABILITY_SECRET".into(), SECRET.into()),
        ("FORGE_AGENT_MODEL_ACCESS_SECRET".into(), SECRET.into()),
        ("AGENT_FAKE_RUNTIME_ENABLED".into(), "true".into()),
        ("OPENAI_API_KEY".into(), "fixture-managed-key".into()),
        ("FORGE_MANAGED_OPENAI_MODELS".into(), "gpt-5".into()),
    ]);
    let storage = forge_server::files::storage::Storage::local(&f.dir).unwrap();
    let settings =
        forge_server::agents::Settings::configured(f.f.database.clone(), storage, &env).unwrap();
    assert!(settings.coordinator.attachments.is_some());
    assert_eq!(
        settings.coordinator.hosted.as_ref().unwrap().runtimes.len(),
        1
    );
    f.f.app = forge_server::router_with_state(
        AppState::configured_database(
            f.f.database.clone(),
            AuthSettings::new(SECRET.into(), ORIGIN).unwrap(),
            None,
        )
        .with_agents(settings),
    );
    let thread = f.thread().await;
    let r = f
        .raw(
            "POST",
            "/api/agent/runs",
            Some(&f.cookie),
            &[("origin", ORIGIN)],
            Body::from(
                json!({"threadId":thread,"selectionMode":"auto","message":"Hello"}).to_string(),
            ),
        )
        .await;
    assert_eq!(r.status(), StatusCode::OK);
    let bytes = r.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("\"content\":\"Done\""));
    assert!(text.contains("event: run.completed"));
    assert!(!text.contains("fixture-managed-key"));
}

#[tokio::test]
async fn configured_native_transport_runs_successive_public_agent_turns_through_the_rust_service() {
    for mode in [
        native_runtime_support::Mode::Finish,
        native_runtime_support::Mode::Budget,
        native_runtime_support::Mode::LargeToolData,
        native_runtime_support::Mode::SensitiveToolData,
    ] {
        let native = native_runtime_support::Fixture::new(mode, false).await;
        let mut f = AgentFixture::new().await;
        let env = std::collections::HashMap::from([
            ("FORGE_RUST_AGENT_TRANSPORT".into(), "native".into()),
            (
                "FORGE_NATIVE_AGENT_RUNTIME_URL".into(),
                native.origin.to_string(),
            ),
            (
                "FORGE_AGENT_CHANNEL_SECRET".into(),
                native_runtime_support::SECRET.into(),
            ),
            ("FORGE_AGENT_LOCAL_INGEST_SECRET".into(), SECRET.into()),
            ("FORGE_AGENT_CAPABILITY_SECRET".into(), SECRET.into()),
            ("FORGE_AGENT_MODEL_ACCESS_SECRET".into(), SECRET.into()),
            ("OPENAI_API_KEY".into(), "fixture-managed-key".into()),
            ("FORGE_MANAGED_OPENAI_MODELS".into(), "gpt-5".into()),
        ]);
        let settings = forge_server::agents::Settings::configured(
            f.f.database.clone(),
            forge_server::files::storage::Storage::local(&f.dir).unwrap(),
            &env,
        )
        .unwrap();
        f.f.app = forge_server::router_with_state(
            AppState::configured_database(
                f.f.database.clone(),
                AuthSettings::new(SECRET.into(), ORIGIN).unwrap(),
                None,
            )
            .with_agents(settings),
        );
        let thread = f.thread().await;
        for message in ["Remember marigold.", "What is the marker?"] {
            let response = f
                .raw(
                    "POST",
                    "/api/agent/runs",
                    Some(&f.cookie),
                    &[("origin", ORIGIN)],
                    Body::from(
                        json!({"threadId":thread,"selectionMode":"auto","message":message})
                            .to_string(),
                    ),
                )
                .await;
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            let text = String::from_utf8_lossy(&bytes);
            if matches!(mode, native_runtime_support::Mode::Budget)
                && message == "What is the marker?"
            {
                assert!(text.contains("event: approval.requested"), "{text}");
                assert!(!text.contains("event: run.completed"));
                assert_eq!(native.script.models.load(Ordering::SeqCst), 1);
                let approval: Uuid = sqlx::query_scalar("SELECT id FROM agent_approvals WHERE run_id IN (SELECT id FROM agent_runs WHERE thread_id=$1) AND capability_id='eve.tool.session_limit_continuation'")
                    .bind(Uuid::parse_str(&thread).unwrap()).fetch_one(&f.f.pool).await.unwrap();
                let response = f
                    .raw(
                        "POST",
                        &format!("/api/agent/approvals/{approval}"),
                        Some(&f.cookie),
                        &[("origin", ORIGIN)],
                        Body::from(json!({"decision":"approved"}).to_string()),
                    )
                    .await;
                assert_eq!(response.status(), StatusCode::OK);
                let bytes = response.into_body().collect().await.unwrap().to_bytes();
                let resumed = String::from_utf8_lossy(&bytes);
                assert!(resumed.contains("event: approval.resolved"), "{resumed}");
                assert!(resumed.contains("event: run.completed"), "{resumed}");
                assert!(resumed.contains("The marker is marigold."));
            } else {
                assert!(text.contains("event: run.completed"), "{text}");
                assert!(text.contains("The marker is marigold."));
            }
            assert!(!text.contains("fixture-managed-key"));
        }
        let cursor: String =
            sqlx::query_scalar("SELECT runtime_session_id FROM agent_threads WHERE id=$1")
                .bind(uuid::Uuid::parse_str(&thread).unwrap())
                .fetch_one(&f.f.pool)
                .await
                .unwrap();
        let cursor = forge_server::native_runtime::Cursor::decode(&cursor).unwrap();
        assert_eq!(cursor.conversation_id.to_string(), thread);
        assert!(cursor.previous_run_id.is_some());
        assert_eq!(
            native.script.models.load(Ordering::SeqCst),
            if matches!(
                mode,
                native_runtime_support::Mode::Finish | native_runtime_support::Mode::Budget
            ) {
                2
            } else {
                3
            }
        );
        let payloads: Vec<String> = sqlx::query_scalar(
            "SELECT payload_json::text FROM agent_events WHERE thread_id=$1 ORDER BY sequence",
        )
        .bind(uuid::Uuid::parse_str(&thread).unwrap())
        .fetch_all(&f.f.pool)
        .await
        .unwrap();
        for payload in &payloads {
            assert!(
                forge_core::agents::contracts::safe_payload(
                    &forge_core::json::parse(payload).unwrap()
                )
                .is_ok()
            );
            assert!(!payload.contains("fixture-credential-should-not-display"));
        }
        if matches!(
            mode,
            native_runtime_support::Mode::LargeToolData
                | native_runtime_support::Mode::SensitiveToolData
        ) {
            assert_eq!(
                payloads
                    .iter()
                    .filter(|v| v.contains("displayDataOmitted"))
                    .count(),
                2
            );
        }
        native.shutdown().await;
    }
}
