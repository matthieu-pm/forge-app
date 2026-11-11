use super::*;
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
