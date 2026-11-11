use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
#[tokio::test]
async fn profile_http_validates_large_raster_avatar_and_persists_explicit_removal() {
    let mut f = Fixture::new().await;
    f.app = forge_server::router_with_state(
        AppState::configured_database(
            f.database.clone(),
            AuthSettings::new(SECRET.into(), ORIGIN).unwrap(),
            Some(f.mailbox.clone()),
        )
        .with_profile_editing(true),
    );
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "Profile HTTP",
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
    let (status, headers, loaded) = f
        .request("GET", "/api/account/profile", Some(&cookie), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(loaded["status"], "ready");
    assert!(
        headers["cache-control"]
            .to_str()
            .unwrap()
            .contains("no-store")
    );
    let mut bytes=STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=").unwrap();
    bytes.resize(forge_core::profiles::MAX_AVATAR_BYTES, 0);
    let image = format!("data:image/png;base64,{}", STANDARD.encode(bytes));
    let input = json!({"commandKey":Uuid::new_v4(),"sessionId":session_id,"expectedWorkspaceId":actor.workspace_id,"expectedRevision":loaded["snapshot"]["revision"],"patch":{"name":" Profile owner ","image":image}});
    let (status, _, saved) = f
        .request(
            "POST",
            "/api/account/profile",
            Some(&cookie),
            Some(input.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["status"], "saved");
    assert_eq!(saved["snapshot"]["image"], image);
    assert_eq!(saved["snapshot"]["name"], "Profile owner");
    let mut invalid = input.clone();
    invalid["commandKey"] = json!(Uuid::new_v4());
    invalid["expectedRevision"] = saved["snapshot"]["revision"].clone();
    invalid["patch"] = json!({"image":"data:image/png;base64,SGVsbG8=","name":"Uncommitted name"});
    let (status, _, rejected) = f
        .request(
            "POST",
            "/api/account/profile",
            Some(&cookie),
            Some(invalid.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rejected["status"], "rejected");
    invalid["patch"] = json!({"image":null});
    let (status, _, removed) = f
        .request("POST", "/api/account/profile", Some(&cookie), Some(invalid))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(removed["snapshot"]["image"].is_null());
    assert_eq!(removed["snapshot"]["name"], "Profile owner");
    let mut wrong = input;
    wrong["patch"] = json!({"title":"wrong session"});
    wrong["sessionId"] = json!("other");
    assert_eq!(
        f.request("POST", "/api/account/profile", Some(&cookie), Some(wrong))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.request("GET", "/api/account/profile", None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn disabled_profiles_still_require_a_session_and_do_not_mutate() {
    let f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "Disabled profiles",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let (status, _, loaded) = f
        .request("GET", "/api/account/profile", Some(&cookie), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(loaded, json!({"status":"disabled"}));
    assert_eq!(
        f.request("GET", "/api/account/profile", None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    let actor = forge_store::authority::session_actor(&f.database, &token)
        .await
        .unwrap();
    let before = forge_store::profiles::read(&f.database, &actor, true)
        .await
        .unwrap();
    let (status, _, _) = f
        .request(
            "POST",
            "/api/account/profile",
            Some(&cookie),
            Some(json!({})),
        )
        .await;
    assert!(!status.is_success());
    assert_eq!(
        forge_store::profiles::read(&f.database, &actor, true)
            .await
            .unwrap(),
        before
    );
}
