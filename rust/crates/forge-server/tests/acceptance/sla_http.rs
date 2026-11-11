use super::*;

#[tokio::test]
async fn sla_http_enforces_cookie_context_live_role_and_revision_contract() {
    let mut f = Fixture::new().await;
    f.database = f.database.clone().with_sla_gate(Arc::new(|w| {
        (
            true,
            forge_core::sla::gate_identity("http-fixture", w, true),
        )
    }));
    let state = AppState::configured_database(
        f.database.clone(),
        AuthSettings::new(SECRET.into(), ORIGIN).unwrap(),
        Some(f.mailbox.clone()),
    );
    f.app = forge_server::router_with_state(state);
    let (user, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "SLA HTTP",
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
    let identity = json!({"workspaceId":actor.workspace_id,"sessionId":session_id});
    let (status, headers, value) = f
        .request(
            "POST",
            "/api/workspace/sla",
            Some(&cookie),
            Some(identity.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["revision"], 0);
    assert!(
        headers["cache-control"]
            .to_str()
            .unwrap()
            .contains("no-store")
    );
    let mut command = identity.clone();
    command["commandKey"] = json!(Uuid::new_v4());
    command["expectedRevision"] = json!(0);
    command["values"] = forge_core::sla::initial();
    let (status, _, value) = f
        .request(
            "POST",
            "/api/workspace/sla/save",
            Some(&cookie),
            Some(command.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["status"], "saved");
    assert_eq!(value["snapshot"]["revision"], 1);
    let (status, _, value) = f
        .request(
            "POST",
            "/api/workspace/sla/save",
            Some(&cookie),
            Some(command.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["replayed"], true);
    let mut wrong = identity.clone();
    wrong["sessionId"] = json!("unbound");
    assert_eq!(
        f.request("POST", "/api/workspace/sla", Some(&cookie), Some(wrong))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.request("POST", "/api/workspace/sla", None, Some(identity.clone()))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    sqlx::query("UPDATE member SET role='member' WHERE organization_id=$1 AND user_id=$2")
        .bind(&actor.workspace_id)
        .bind(user.id)
        .execute(&f.pool)
        .await
        .unwrap();
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/sla/save",
            Some(&cookie),
            Some(command)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.request("POST", "/api/workspace/sla", Some(&cookie), Some(identity))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}
