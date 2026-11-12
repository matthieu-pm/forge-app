use super::*;
#[tokio::test]
async fn call_sync_and_summary_http_bind_current_sessions_and_publish_native_results() {
    use forge_core::calls::providers::{Error, TokenRequest};
    use forge_server::call_providers::{Client, Settings, Transport};
    use std::{
        collections::HashMap,
        sync::atomic::{AtomicUsize, Ordering},
    };
    struct Provider {
        reads: AtomicUsize,
        summaries: AtomicUsize,
        started: chrono::DateTime<chrono::Utc>,
    }
    #[async_trait]
    impl Transport for Provider {
        async fn exchange(&self, _: TokenRequest) -> Result<Value, Error> {
            panic!("unexpired tokens");
        }
        async fn read(&self, url: &str, token: &str) -> Result<String, Error> {
            assert_eq!(token, "private-access");
            self.reads.fetch_add(1, Ordering::SeqCst);
            let time = forge_core::loops::iso_timestamp(self.started);
            let data = if url.contains("/entries?") {
                json!({"transcriptEntries":[{"participant":"p1","startTime":time,"text":"Start the pilot."}]})
            } else if url.contains("/participants?") {
                json!({"participants":[{"name":"p1","signedinUser":{"displayName":"Alex"}}]})
            } else if url.contains("/transcripts?") {
                json!({"transcripts":[{"name":"conferenceRecords/c1/transcripts/t1","state":"FILE_GENERATED"}]})
            } else {
                assert!(url.starts_with("https://meet.googleapis.com/v2/conferenceRecords?"));
                json!({"conferenceRecords":[{"name":"conferenceRecords/c1","space":"spaces/team","startTime":time,"endTime":forge_core::loops::iso_timestamp(self.started+chrono::Duration::minutes(30))}]})
            };
            Ok(data.to_string())
        }
        async fn summary(&self, key: &str, request: Value) -> Result<Value, Error> {
            assert_eq!(key, "private-ai-key");
            assert_eq!(request["messages"][1]["content"], "Alex: Start the pilot.");
            self.summaries.fetch_add(1, Ordering::SeqCst);
            Ok(
                json!({"choices":[{"message":{"content":json!({"summary":"Pilot approved.","decisions":["Start the pilot"],"actions":[{"title":"Start pilot","owner":""}]}).to_string()}}]}),
            )
        }
    }
    let mut f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "Calls pipeline HTTP",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &token)
        .await
        .unwrap();
    let forge_core::actor::Authentication::Session { session_id } = &actor.authentication else {
        panic!()
    };
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Calls","identifier":"CPIP","timezone":"UTC","icon":{"kind":"icon","value":"File01Icon","color":"#818cf8"}})).unwrap()).await.unwrap();
    let provider = Arc::new(Provider {
        reads: 0.into(),
        summaries: 0.into(),
        started: chrono::Utc::now() - chrono::Duration::hours(1),
    });
    let environment = HashMap::from([
        ("BETTER_AUTH_URL".into(), ORIGIN.into()),
        ("OPENAI_API_KEY".into(), "private-ai-key".into()),
        ("FORGE_GOOGLE_MEET_CLIENT_ID".into(), "fixture-id".into()),
        (
            "FORGE_GOOGLE_MEET_CLIENT_SECRET".into(),
            "private-secret".into(),
        ),
    ]);
    let client = Arc::new(Client::new(environment.clone(), provider.clone()));
    let vault = Arc::new(
        forge_identity::model_vault::Vault::new("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
            .unwrap(),
    );
    let id = Uuid::new_v4();
    let secret = vault
        .seal(
            &json!({"access_token":"private-access","expires_at":4102444800000.}).to_string(),
            &format!("meeting:{}:{id}", actor.workspace_id),
        )
        .unwrap();
    sqlx::query("INSERT INTO call_connections(id,workspace_id,user_id,team_id,provider,secret) VALUES($1,$2,$3,$4,'google',$5)").bind(id).bind(&actor.workspace_id).bind(&actor.user_id).bind(team.id).bind(secret).execute(&f.pool).await.unwrap();
    f.app = forge_server::router_with_state(
        AppState::configured(
            f.pool.clone(),
            AuthSettings::new(SECRET.into(), ORIGIN).unwrap(),
            None,
        )
        .with_calls(Settings {
            options: forge_store::calls::Options { environment },
            gateway: client.clone(),
            summarizer: Some(client),
            vault: Some(vault),
        }),
    );
    let base = json!({"workspaceId":actor.workspace_id,"sessionId":session_id});
    let mut wrong = base.clone();
    wrong["sessionId"] = json!("wrong");
    for path in ["/api/workspace/calls/sync", "/api/workspace/calls/summary"] {
        assert_eq!(
            f.request("POST", path, None, Some(base.clone())).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            f.request("POST", path, Some(&cookie), Some(wrong.clone()))
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        provider.reads.load(Ordering::SeqCst) + provider.summaries.load(Ordering::SeqCst),
        0
    );
    for expected in [1, 0] {
        let (status, _, body) = f
            .request(
                "POST",
                "/api/workspace/calls/sync",
                Some(&cookie),
                Some(base.clone()),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, expected);
    }
    let (_, _, rows) = f
        .request(
            "POST",
            "/api/workspace/calls",
            Some(&cookie),
            Some(base.clone()),
        )
        .await;
    let mut read = base;
    read["callId"] = rows["calls"][0]["id"].clone();
    for _ in 0..2 {
        let (status, _, body) = f
            .request(
                "POST",
                "/api/workspace/calls/summary",
                Some(&cookie),
                Some(read.clone()),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body.is_null());
    }
    let (status, _, record) = f
        .request(
            "POST",
            "/api/workspace/calls/read",
            Some(&cookie),
            Some(read),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(record["summary"], "Pilot approved.");
    assert_eq!(record["actions"].as_array().unwrap().len(), 1);
    assert_eq!(provider.summaries.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn call_http_binds_sessions_requires_consent_and_preserves_unicode_transcripts_and_retention()
{
    let f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "Calls HTTP",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &token)
        .await
        .unwrap();
    let forge_core::actor::Authentication::Session { session_id } = &actor.authentication else {
        panic!()
    };
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Calls","identifier":"CAL","timezone":"UTC","icon":{"kind":"icon","value":"File01Icon","color":"#818cf8"}})).unwrap()).await.unwrap();
    let mut input = json!({"workspaceId":actor.workspace_id,"sessionId":session_id,"teamId":team.id,
        "title":" Review ","startedAt":forge_core::loops::iso_timestamp(chrono::Utc::now()-chrono::Duration::days(10)),
        "text":format!("Alex: {}\nSam: Follow up.","語".repeat(20000)),"consentConfirmed":false});
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/calls/import",
            Some(&cookie),
            Some(input.clone())
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    input["consentConfirmed"] = json!(true);
    let mut wrong = input.clone();
    wrong["sessionId"] = json!("wrong-session");
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/calls/import",
            Some(&cookie),
            Some(wrong)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, _, id) = f
        .request(
            "POST",
            "/api/workspace/calls/import",
            Some(&cookie),
            Some(input),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{id}");
    assert!(id.as_str().is_some());
    let base = json!({"workspaceId":actor.workspace_id,"sessionId":session_id});
    let (status, _, directory) = f
        .request(
            "POST",
            "/api/workspace/calls",
            Some(&cookie),
            Some(base.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{directory}");
    assert_eq!(directory["calls"][0]["transcript"], json!([]));
    let mut read = base.clone();
    read["callId"] = id.clone();
    let (status, _, record) = f
        .request(
            "POST",
            "/api/workspace/calls/read",
            Some(&cookie),
            Some(read.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{record}");
    assert_eq!(
        record["transcript"][0]["text"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        20000
    );
    let mut note = read.clone();
    note["body"] = json!("  Team note  ");
    note["kind"] = json!("note");
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/calls/notes",
            Some(&cookie),
            Some(note)
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut retention = base.clone();
    retention["days"] = json!(7);
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/calls/retention",
            Some(&cookie),
            Some(retention)
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, _, record) = f
        .request(
            "POST",
            "/api/workspace/calls/read",
            Some(&cookie),
            Some(read.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{record}");
    assert_eq!(record["status"], "expired");
    assert_eq!(record["transcript"], json!([]));
    assert_eq!(record["notes"][0]["body"], "Team note");
    assert_eq!(
        f.request("POST", "/api/workspace/calls/read", None, Some(read))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn meeting_oauth_http_uses_bound_sessions_and_redacted_single_use_callback_redirects() {
    use forge_core::calls::providers::{Error, TokenRequest};
    use forge_server::call_providers::{Client, Settings, Transport};
    use std::{
        collections::HashMap,
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    #[derive(Default)]
    struct Provider {
        calls: AtomicUsize,
        fail: AtomicBool,
    }
    #[async_trait]
    impl Transport for Provider {
        async fn exchange(&self, r: TokenRequest) -> Result<Value, Error> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(r.url, "https://oauth2.googleapis.com/token");
            let f: HashMap<_, _> = r.form.into_iter().collect();
            assert_eq!(f["code_verifier"].len(), 43);
            assert_eq!(f["client_secret"], "private-client-secret");
            assert_eq!(
                f["redirect_uri"],
                format!("{ORIGIN}/api/calls/oauth/callback")
            );
            if self.fail.load(Ordering::SeqCst) {
                return Err(Error);
            }
            Ok(
                json!({"access_token":"private-access-token","refresh_token":"private-refresh-token","expires_in":3600}),
            )
        }
    }
    let mut f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "Meeting HTTP",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &token)
        .await
        .unwrap();
    let forge_core::actor::Authentication::Session { session_id } = &actor.authentication else {
        panic!()
    };
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Meetings","identifier":"MEET","timezone":"UTC","icon":{"kind":"icon","value":"File01Icon","color":"#818cf8"}})).unwrap()).await.unwrap();
    let key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    let env = HashMap::from([
        ("BETTER_AUTH_URL".into(), ORIGIN.into()),
        ("FORGE_MODEL_CREDENTIAL_KEK".into(), key.into()),
        ("FORGE_GOOGLE_MEET_CLIENT_ID".into(), "fixture-id".into()),
        (
            "FORGE_GOOGLE_MEET_CLIENT_SECRET".into(),
            "private-client-secret".into(),
        ),
    ]);
    let provider = Arc::new(Provider::default());
    let settings = Settings {
        summarizer: None,
        options: forge_store::calls::Options {
            environment: env.clone(),
        },
        gateway: Arc::new(Client::new(env, provider.clone())),
        vault: Some(Arc::new(
            forge_identity::model_vault::Vault::new(key).unwrap(),
        )),
    };
    f.app = forge_server::router_with_state(
        AppState::configured(
            f.pool.clone(),
            AuthSettings::new(SECRET.into(), ORIGIN).unwrap(),
            None,
        )
        .with_calls(settings),
    );
    let input = json!({"workspaceId":actor.workspace_id,"sessionId":session_id,"provider":"google","teamId":team.id,"consentConfirmed":true});
    let mut denied = input.clone();
    denied["consentConfirmed"] = json!(false);
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/calls/connect",
            Some(&cookie),
            Some(denied)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let mut wrong = input.clone();
    wrong["sessionId"] = json!("old-session");
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/calls/connect",
            Some(&cookie),
            Some(wrong)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for fail in [false, true] {
        let (status, _, body) = f
            .request(
                "POST",
                "/api/workspace/calls/connect",
                Some(&cookie),
                Some(input.clone()),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let url = url::Url::parse(body.as_str().unwrap()).unwrap();
        let ticket = url
            .query_pairs()
            .find(|(k, _)| k == "state")
            .unwrap()
            .1
            .into_owned();
        let path = format!("/api/calls/oauth/callback?state={ticket}&code=private-code");
        let (status, headers, body) = f.request("GET", &path, None, None).await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        assert_eq!(
            headers[header::LOCATION],
            "/workspace/calls?connection=error"
        );
        assert!(body.is_null());
        provider.fail.store(fail, Ordering::SeqCst);
        let (status, headers, body) = f.request("GET", &path, Some(&cookie), None).await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(headers[header::REFERRER_POLICY], "no-referrer");
        assert!(body.is_null());
        assert_eq!(
            headers[header::LOCATION],
            if fail {
                "/workspace/calls?connection=error"
            } else {
                "/workspace/calls?connection=connected"
            }
        );
        assert!(!format!("{headers:?}").contains("private-"));
        let (_, headers, _) = f.request("GET", &path, Some(&cookie), None).await;
        assert_eq!(
            headers[header::LOCATION],
            "/workspace/calls?connection=error"
        );
    }
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    for path in [
        "/api/calls/oauth/callback?error=private-provider-error",
        "/api/calls/oauth/callback?state=x",
        &format!("/api/calls/oauth/callback?state={}&code=x", "a".repeat(257)),
    ] {
        let (status, headers, body) = f.request("GET", path, Some(&cookie), None).await;
        assert_eq!(status, StatusCode::SEE_OTHER);
        assert_eq!(
            headers[header::LOCATION],
            "/workspace/calls?connection=error"
        );
        assert!(body.is_null());
    }
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
}
