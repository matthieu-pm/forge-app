use super::*;

#[tokio::test]
async fn template_application_http_binds_sessions_gates_creation_and_replays_results() {
    let mut f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "Template application HTTP",
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
    let base = json!({"workspaceId":actor.workspace_id,"sessionId":session_id});
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Templates","identifier":"TPL","icon":{"kind":"icon","value":"File01Icon","color":"#818cf8"},"timezone":"UTC"})).unwrap()).await.unwrap();
    let mut p = forge_core::templates::empty("issue", Some(&team.id.to_string()));
    p["name"] = json!("HTTP template");
    p["title"] = json!("Created over HTTP");
    p["visibility"] = json!("");
    forge_store::templates::save(&f.database, &actor, json!({"payload":p}), false)
        .await
        .unwrap();
    let configure = |enabled| {
        forge_server::router_with_state(
            AppState::configured(
                f.pool.clone(),
                AuthSettings::new(SECRET.into(), ORIGIN).unwrap(),
                Some(f.mailbox.clone()),
            )
            .with_template_application(forge_store::template_application::Options {
                enabled,
                ..Default::default()
            }),
        )
    };
    f.app = configure(false);
    let (status, _, directory) = f
        .request(
            "POST",
            "/api/workspace/templates/applications",
            Some(&cookie),
            Some(base.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(directory["enabled"], false);
    f.app = configure(true);
    let (status, headers, directory) = f
        .request(
            "POST",
            "/api/workspace/templates/applications",
            Some(&cookie),
            Some(base.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{directory}");
    assert!(
        headers["cache-control"]
            .to_str()
            .unwrap()
            .contains("no-store")
    );
    assert_eq!(directory["templates"].as_array().unwrap().len(), 1);
    let (status, _, refs) = f
        .request(
            "POST",
            "/api/workspace/templates/references",
            Some(&cookie),
            Some(base.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{refs}");
    assert!(refs["catalog"]["statuses"]["statuses"].is_array());
    let mut input = base;
    input["templateId"] = directory["templates"][0]["id"].clone();
    input["revision"] = directory["templates"][0]["revision"].clone();
    input["commandKey"] = json!(Uuid::new_v4());
    let (status, _, first) = f
        .request(
            "POST",
            "/api/workspace/templates/apply",
            Some(&cookie),
            Some(input.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert_eq!(first["ok"], true, "{first}");
    let (status, _, retry) = f
        .request(
            "POST",
            "/api/workspace/templates/apply",
            Some(&cookie),
            Some(input.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(retry["replayed"], true);
    assert_eq!(retry["value"], first["value"]);
    let mut stale = input.clone();
    stale["commandKey"] = json!(Uuid::new_v4());
    stale["revision"] = json!("0".repeat(64));
    let (status, _, rejected) = f
        .request(
            "POST",
            "/api/workspace/templates/apply",
            Some(&cookie),
            Some(stale),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rejected["code"], "TEMPLATE_VALIDATION");
    let mut wrong = input.clone();
    wrong["sessionId"] = json!("wrong");
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/templates/apply",
            Some(&cookie),
            Some(wrong)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let mut extra = input.clone();
    extra["extra"] = json!(true);
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/templates/apply",
            Some(&cookie),
            Some(extra)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/templates/apply",
            None,
            Some(input.clone())
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    f.app = configure(false);
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/templates/apply",
            Some(&cookie),
            Some(input)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
}
#[tokio::test]
async fn template_http_preserves_large_deep_content_conflicts_and_session_binding() {
    let f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "Template HTTP",
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
    let base = json!({"workspaceId":actor.workspace_id,"sessionId":session_id});
    let mut payload = forge_core::templates::empty("issue", None);
    payload["name"] = json!("Large template");
    let mut node = json!({"type":"text","text":"語".repeat(800_000)});
    for _ in 0..63 {
        node = json!({"type":"blockquote","content":[node]});
    }
    payload["content"] = json!({"type":"doc","content":[node]});
    let mut input = base.clone();
    input["payload"] = payload.clone();
    let (status, _, saved) = f
        .request(
            "POST",
            "/api/workspace/templates/save",
            Some(&cookie),
            Some(input.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let (status, headers, loaded) = f
        .request(
            "POST",
            "/api/workspace/templates/read",
            Some(&cookie),
            Some(base.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{loaded}");
    assert!(
        headers["cache-control"]
            .to_str()
            .unwrap()
            .contains("no-store")
    );
    assert_eq!(loaded["templates"][0]["payload"], payload);
    input["id"] = saved["id"].clone();
    input["updatedAt"] = loaded["templates"][0]["updatedAt"].clone();
    input["payload"]["title"] = json!("Saved edit");
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/templates/save",
            Some(&cookie),
            Some(input.clone())
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/templates/save",
            Some(&cookie),
            Some(input.clone())
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    input["sessionId"] = json!("foreign-session");
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/templates/save",
            Some(&cookie),
            Some(input)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/templates/read",
            None,
            Some(base.clone())
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    // The source ceiling disables recurring issues at the public boundary.
    for route in ["read", "save", "delete"] {
        assert_eq!(
            f.request(
                "POST",
                &format!("/api/workspace/recurring-issues/{route}"),
                Some(&cookie),
                Some(base.clone())
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    let mut remove = base;
    remove["id"] = saved["id"].clone();
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/templates/delete",
            Some(&cookie),
            Some(remove)
        )
        .await
        .0,
        StatusCode::OK
    );
}
