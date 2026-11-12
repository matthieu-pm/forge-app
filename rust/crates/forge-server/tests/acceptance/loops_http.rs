use super::*;
async fn webhook(
    f: &Fixture,
    id: Uuid,
    method: &str,
    token: Option<&str>,
    key: Option<&str>,
    media: &str,
    body: Vec<u8>,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(format!("/api/loops/webhooks/{id}"))
        .header("content-type", media);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    if let Some(key) = key {
        request = request.header("webhook-id", key);
    }
    let response = f
        .app
        .clone()
        .oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn loop_http_binds_management_and_accepts_bounded_authorized_webhook_retries() {
    let mut f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "Loop HTTP",
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
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Loop team","identifier":"LOP","icon":{"kind":"icon","value":"File01Icon","color":"#818cf8"},"timezone":"UTC"})).unwrap()).await.unwrap();
    let base = json!({"workspaceId":actor.workspace_id,"sessionId":session_id,"teamId":team.id});
    let options = forge_store::loops::Options::from_environment(std::collections::HashMap::from([
        ("NODE_ENV".into(), "test".into()),
        ("FORGE_LOOPS_ENABLED".into(), "true".into()),
        ("AGENT_FAKE_RUNTIME_ENABLED".into(), "true".into()),
        (
            "FORGE_LOOP_WEBHOOK_SECRET".into(),
            "local-http-loop-secret-at-least-32".into(),
        ),
    ]));
    f.app = forge_server::router_with_state(
        AppState::configured(
            f.pool.clone(),
            AuthSettings::new(SECRET.into(), ORIGIN).unwrap(),
            Some(f.mailbox.clone()),
        )
        .with_loops(options),
    );
    let id = Uuid::new_v4();
    let mut input = base.clone();
    input["commandKey"] = json!(Uuid::new_v4());
    input["command"] = json!({"action":"create","id":id,"fields":{"name":"Webhook","description":"","instructions":"Handle event","trigger":{"kind":"webhook"},"conditions":[],"reasoning":"auto","teamAccess":"this-team"}});
    let (status, _, body) = f
        .request(
            "POST",
            "/api/workspace/loops",
            Some(&cookie),
            Some(input.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["revision"], 1);
    let mut wrong = input.clone();
    wrong["sessionId"] = json!("other-session");
    assert_eq!(
        f.request("POST", "/api/workspace/loops", Some(&cookie), Some(wrong))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    input["commandKey"] = json!(Uuid::new_v4());
    input["command"] = json!({"action":"rotate-webhook","id":id,"expectedRevision":1});
    let (status, _, secret) = f
        .request(
            "POST",
            "/api/workspace/loops",
            Some(&cookie),
            Some(input.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{secret}");
    let token = secret["webhookSecret"].as_str().unwrap();
    sqlx::query("INSERT INTO workspace_security_settings(workspace_id,external_loop_sources_enabled) VALUES($1,true) ON CONFLICT(workspace_id) DO UPDATE SET external_loop_sources_enabled=true").bind(&actor.workspace_id).execute(&f.pool).await.unwrap();
    input["commandKey"] = json!(Uuid::new_v4());
    input["command"] = json!({"action":"enable","id":id,"expectedRevision":2});
    let (status, _, result) = f
        .request("POST", "/api/workspace/loops", Some(&cookie), Some(input))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let raw = br#"{"event":"changed"}"#.to_vec();
    let with_bom = [0xef, 0xbb, 0xbf]
        .into_iter()
        .chain(raw.iter().copied())
        .collect();
    let first = webhook(
        &f,
        id,
        "POST",
        Some(token),
        Some("event-1"),
        "application/json",
        with_bom,
    )
    .await;
    assert_eq!(first.0, StatusCode::ACCEPTED, "{:?}", first.1);
    assert_eq!(
        webhook(
            &f,
            id,
            "POST",
            Some(token),
            Some("event-1"),
            "application/json",
            raw
        )
        .await,
        first
    );
    assert_eq!(
        webhook(
            &f,
            id,
            "POST",
            Some(token),
            Some("event-1"),
            "application/json",
            b"null".to_vec()
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    for (method, token, key, media, body, expected) in [
        (
            "GET",
            None,
            None,
            "application/json",
            vec![],
            StatusCode::METHOD_NOT_ALLOWED,
        ),
        (
            "POST",
            None,
            Some("key"),
            "application/json",
            b"{}".to_vec(),
            StatusCode::NOT_FOUND,
        ),
        (
            "POST",
            Some(token),
            None,
            "application/json",
            b"{}".to_vec(),
            StatusCode::BAD_REQUEST,
        ),
        (
            "POST",
            Some(token),
            Some("key"),
            "text/plain",
            b"{}".to_vec(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            "POST",
            Some(token),
            Some("key"),
            "application/json",
            vec![b' '; 131073],
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            "POST",
            Some(token),
            Some("key"),
            "application/json",
            b"{broken".to_vec(),
            StatusCode::BAD_REQUEST,
        ),
        (
            "POST",
            Some(token),
            Some("key"),
            "application/json",
            b"1e999".to_vec(),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        assert_eq!(
            webhook(&f, id, method, token, key, media, body).await.0,
            expected
        );
    }
    let (status, _, directory) = f
        .request(
            "POST",
            "/api/workspace/loops/read",
            Some(&cookie),
            Some(base),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{directory}");
    assert_eq!(directory["runs"].as_array().unwrap().len(), 1);
    sqlx::query("UPDATE workspace_security_settings SET external_loop_sources_enabled=false WHERE workspace_id=$1").bind(&actor.workspace_id).execute(&f.pool).await.unwrap();
    assert_eq!(
        webhook(
            &f,
            id,
            "POST",
            Some(token),
            Some("event-1"),
            "application/json",
            br#"{"event":"changed"}"#.to_vec()
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}
