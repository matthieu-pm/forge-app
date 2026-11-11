use super::*;

#[tokio::test]
async fn enabled_invitation_http_queues_owned_work_and_scopes_retries_without_synchronous_mail() {
    let mut f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    let workspace = forge_store::workspaces::create(
        &f.database,
        &token,
        "Workflow HTTP",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let workspace_id = workspace.id.clone();
    f.app = forge_server::router_with_state(
        AppState::configured_database(
            f.database.clone(),
            AuthSettings::new(SECRET.into(), ORIGIN).unwrap(),
            None,
        )
        .with_invitation_gate(Arc::new(move |id| id == workspace_id)),
    );
    let email = format!("{}@example.test", Uuid::new_v4());
    let (status, _, result) = f
        .request(
            "POST",
            "/api/workspace/invitations",
            Some(&cookie),
            Some(json!({"email":email,"role":"member"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["delivery"]["state"], "queued");
    let business = result["delivery"]["businessRunId"].as_str().unwrap();
    let owner: Option<String> =
        sqlx::query_scalar("SELECT sdk_run_id FROM business_workflow_runs WHERE id=$1::uuid")
            .bind(business)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert!(owner.unwrap().starts_with("forge-native-job:"));
    assert!(f.mailbox.1.lock().unwrap().is_empty());
    let (status, _, retried) = f
        .request(
            "POST",
            "/api/workspace/invitations/retry",
            Some(&cookie),
            Some(json!({"businessRunId":business})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{retried}");
    assert_eq!(retried["businessRunId"], business);
    let (status, _, resent) = f
        .request(
            "POST",
            "/api/workspace/invitations",
            Some(&cookie),
            Some(json!({"email":email,"role":"member","resend":true})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{resent}");
    assert_eq!(resent["delivery"]["businessRunId"], business);
    let (_, other_token, other_cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &other_token,
        "Other",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/invitations/retry",
            Some(&other_cookie),
            Some(json!({"businessRunId":business}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/invitations/retry",
            None,
            Some(json!({"businessRunId":business}))
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM background_jobs WHERE identity=$1 AND kind=$2")
            .bind(business)
            .bind(forge_store::jobs::invitations::KIND)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
}
