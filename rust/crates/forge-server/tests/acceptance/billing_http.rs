use super::*;
use chrono::{Duration, Utc};
use forge_core::{billing::calendar::stamp, features::FeatureRollouts};
use forge_server::billing::Settings;

const BILLING: &str = "/api/workspace/billing";

fn configure(f: &mut Fixture, enabled: bool, workspaces: &[&str]) {
    let rollout = json!({"billing":{"mode":"enabled","workspaceIds":workspaces}}).to_string();
    f.app = forge_server::router_with_state(
        AppState::configured_database(
            f.database.clone(),
            AuthSettings::new(SECRET.into(), ORIGIN).unwrap(),
            Some(f.mailbox.clone()),
        )
        .with_billing(Settings {
            enabled,
            rollouts: FeatureRollouts::parse(Some(&rollout)).unwrap(),
            webhook: None,
        }),
    );
}

async fn paid_workspace(f: &Fixture, workspace: &str) -> String {
    let subscription = Uuid::new_v4().to_string();
    let now = Utc::now();
    forge_store::billing::Service::new(f.database.clone())
        .apply_subscription_snapshot(json!({
            "eventId":Uuid::new_v4(),"bodyHash":"d".repeat(64),
            "snapshot":{"workspaceId":workspace,"environment":"sandbox","subscriptionId":subscription,
                "plan":"starter","status":"active","updatedAt":stamp(now-Duration::days(1)),
                "currentPeriodStart":stamp(now-Duration::days(2)),"currentPeriodEnd":stamp(now+Duration::days(28)),
                "pastDueAt":null},
        }))
        .await
        .unwrap();
    subscription
}

#[tokio::test]
async fn billing_summary_requires_session_and_rollout_but_all_current_member_roles_can_read() {
    let mut f = Fixture::new().await;
    let (user, token, cookie) = f.account().await;
    let workspace = forge_store::workspaces::create(
        &f.database,
        &token,
        "Billing summary",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let private_subscription = paid_workspace(&f, &workspace.id).await;

    let (status, _, value) = f.request("GET", BILLING, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{value}");
    assert_eq!(value["code"], "UNAUTHORIZED");
    // An absent configuration, an off billing switch, and another workspace's
    // allowlist each deny this same authenticated request.
    let (status, _, value) = f.request("GET", BILLING, Some(&cookie), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{value}");
    for (enabled, allowed) in [(false, workspace.id.as_str()), (true, "another-workspace")] {
        configure(&mut f, enabled, &[allowed]);
        let (status, _, value) = f.request("GET", BILLING, Some(&cookie), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{value}");
        assert_eq!(value["code"], "FORBIDDEN");
        assert!(!value.to_string().contains(&private_subscription));
    }
    configure(&mut f, true, &[&workspace.id]);
    let expected =
        json!({"plan":"basic","phase":"paid","activeMembers":1,"notices":[],"trialExpiresAt":null});
    for role in ["owner", "admin", "member", "guest"] {
        sqlx::query("UPDATE member SET role=$1 WHERE organization_id=$2 AND user_id=$3")
            .bind(role)
            .bind(&workspace.id)
            .bind(&user.id)
            .execute(&f.pool)
            .await
            .unwrap();
        let (status, headers, value) = f.request("GET", BILLING, Some(&cookie), None).await;
        assert_eq!(status, StatusCode::OK, "{role}: {value}");
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        assert_eq!(headers[header::VARY], "Cookie");
        // Exactly the five owning fields; provider identifiers, session data,
        // receipts, and full entitlement records stay outside the response.
        assert_eq!(value, expected, "{role}");
        for private in [&private_subscription, &token, &user.id, &workspace.id] {
            assert!(!value.to_string().contains(private));
        }
    }
}

#[tokio::test]
async fn billing_summary_ignores_workspace_claims_and_rechecks_revoked_sessions_and_membership() {
    let mut f = Fixture::new().await;
    let (user, token, cookie) = f.account().await;
    let own = forge_store::workspaces::create(
        &f.database,
        &token,
        "Current billing workspace",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let (other_user, other_token, other_cookie) = f.account().await;
    let foreign = forge_store::workspaces::create(
        &f.database,
        &other_token,
        "Foreign billing workspace",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let foreign_subscription = paid_workspace(&f, &foreign.id).await;
    configure(&mut f, true, &[&own.id, &foreign.id]);
    let (status, _, baseline) = f.request("GET", BILLING, Some(&cookie), None).await;
    assert_eq!(status, StatusCode::OK, "{baseline}");
    assert_eq!(baseline["plan"], "free");
    let claimed = format!(
        "{BILLING}?workspaceId={}&organizationId={}&plan=business&activeMembers=999&enabled=true",
        foreign.id, foreign.id
    );
    let claims = json!({"workspaceId":foreign.id,"userId":other_user.id,"subscriptionId":foreign_subscription,"plan":"business","enabled":true});
    let (status, _, result) = f
        .request("GET", &claimed, Some(&cookie), Some(claims.clone()))
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result, baseline);
    assert!(!result.to_string().contains(&foreign_subscription));

    configure(&mut f, true, &[&foreign.id]);
    let (status, _, result) = f
        .request("GET", &claimed, Some(&cookie), Some(claims))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{result}");
    let (status, _, foreign_result) = f.request("GET", BILLING, Some(&other_cookie), None).await;
    assert_eq!(status, StatusCode::OK, "{foreign_result}");
    assert_eq!(foreign_result["plan"], "basic");

    configure(&mut f, true, &[&own.id, &foreign.id]);
    sqlx::query("DELETE FROM session WHERE token=$1")
        .bind(&token)
        .execute(&f.pool)
        .await
        .unwrap();
    let (status, _, result) = f.request("GET", BILLING, Some(&cookie), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{result}");
    let replacement_token = Uuid::new_v4().to_string();
    accounts::create_session(&f.database, &user.id, &replacement_token, true, None)
        .await
        .unwrap();
    let replacement_cookie = format!(
        "better-auth.session_token={}",
        forge_identity::sign_session_token(&replacement_token, SECRET).unwrap()
    );
    assert_eq!(
        f.request("GET", BILLING, Some(&replacement_cookie), None)
            .await
            .2,
        baseline
    );
    sqlx::query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2")
        .bind(&own.id)
        .bind(&user.id)
        .execute(&f.pool)
        .await
        .unwrap();
    let (status, _, result) = f
        .request("GET", &claimed, Some(&replacement_cookie), None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{result}");
    assert_eq!(result["code"], "FORBIDDEN");
    assert_eq!(
        f.request("GET", BILLING, Some(&other_cookie), None).await.2,
        foreign_result
    );
}
