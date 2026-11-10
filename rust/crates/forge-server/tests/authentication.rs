use async_trait::async_trait;
use axum::{
    Router,
    body::Body,
    http::{HeaderMap, Request, StatusCode, header},
};
use forge_server::{
    mail::{InvitationMessage, MailError, VerificationMailer},
    state::{AppState, AuthSettings},
};
use forge_store::accounts::{self, User};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::sync::{Arc, Mutex};
use tower::ServiceExt;
use uuid::Uuid;

const SECRET: &str = "local-test-secret-that-is-at-least-32-bytes-long";
const ORIGIN: &str = "http://localhost:3100";

#[derive(Default)]
struct Mailbox(
    Mutex<Vec<(String, String)>>,
    Mutex<Vec<InvitationMessage>>,
    std::sync::atomic::AtomicBool,
);

#[async_trait]
impl VerificationMailer for Mailbox {
    async fn send_invitation(&self, message: &InvitationMessage) -> Result<(), MailError> {
        if self.2.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(MailError);
        }
        self.1.lock().unwrap().push(message.clone());
        Ok(())
    }
    async fn send(&self, user: &User, url: &str) -> Result<(), MailError> {
        self.0
            .lock()
            .unwrap()
            .push((user.email.clone(), url.to_owned()));
        Ok(())
    }
}

#[tokio::test]
async fn workspace_security_keys_and_invitation_delivery_work_through_http() {
    let f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    let workspace = forge_store::workspaces::create(
        &f.database,
        &token,
        "HTTP workspace",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let (status, _, snapshot) = f
        .request("GET", "/api/workspace/security", Some(&cookie), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{snapshot}");
    assert_eq!(snapshot["version"], 1);
    assert_eq!(snapshot["canManage"], true);
    let (status, _, invalid_domain) = f
        .request(
            "POST",
            "/api/workspace/security",
            Some(&cookie),
            Some(json!({"type":"add-domain","domain":"localhost","expectedVersion":1})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(invalid_domain["code"], "VALIDATION_FAILED");
    let link = snapshot["inviteLink"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap();
    let (status, _, preview) = f
        .request(
            "GET",
            &format!("/api/workspace/invite-preview?token={link}"),
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(preview["workspaceName"], "HTTP workspace");
    let (status, _, rejected) = f
        .request(
            "POST",
            "/api/workspace/security",
            Some(&cookie),
            Some(
                json!({"type":"set-boolean","key":"hipaaEnabled","value":true,"expectedVersion":1}),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rejected["code"], "PLAN_REQUIRED");
    assert_eq!(rejected["requiredPlan"], "enterprise");
    let (status, _, invalid) = f
        .request(
            "POST",
            "/api/workspace/security",
            Some(&cookie),
            Some(
                json!({"type":"set-boolean","key":"notASetting","value":true,"expectedVersion":1}),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{invalid}");
    let (status, _, key) = f
        .request(
            "POST",
            "/api/workspace/api-keys",
            Some(&cookie),
            Some(json!({"name":"Integration","scopes":["teams:read"]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{key}");
    assert!(key["key"].as_str().unwrap().starts_with("forge_"));
    let (status, _, listed) = f
        .request("GET", "/api/workspace/api-keys", Some(&cookie), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed[0], key["summary"]);
    assert!(!listed.to_string().contains(key["key"].as_str().unwrap()));
    let (recipient, _, recipient_cookie) = f.account().await;
    let (status, _, invitation) = f
        .request(
            "POST",
            "/api/workspace/invitations",
            Some(&cookie),
            Some(json!({"email":recipient.email,"role":"member"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{invitation}");
    assert_eq!(invitation["delivery"], "sent-synchronously");
    let messages = f.mailbox.1.lock().unwrap().clone();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].email, recipient.email);
    assert_eq!(messages[0].organization_name, "HTTP workspace");
    assert_eq!(messages[0].url, invitation["invitation"]["url"]);
    let (status, _, accepted) = f
        .request(
            "POST",
            "/api/auth/organization/accept-invitation",
            Some(&recipient_cookie),
            Some(json!({"invitationId":invitation["invitation"]["id"]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    let (status, _, access) = f
        .request(
            "GET",
            "/api/workspace/members",
            Some(&recipient_cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{access}");
    assert_eq!(access["members"].as_array().unwrap().len(), 2);
    assert_eq!(access["canManage"], false);
    let (status, _, denied) = f
        .request(
            "GET",
            "/api/workspace/security",
            Some(&recipient_cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{denied}");
    let active: String =
        sqlx::query_scalar("SELECT active_organization_id FROM session WHERE user_id=$1")
            .bind(&recipient.id)
            .fetch_one(&f.pool)
            .await
            .unwrap();
    assert_eq!(active, workspace.id);
}

#[tokio::test]
async fn failed_invitation_delivery_is_reported_and_can_be_resent() {
    let f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    let workspace = forge_store::workspaces::create(
        &f.database,
        &token,
        "Mail failure",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    f.mailbox
        .2
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let email = format!("{}@example.test", Uuid::new_v4());
    let (status, _, failure) = f
        .request(
            "POST",
            "/api/workspace/invitations",
            Some(&cookie),
            Some(json!({"email":email,"role":"admin"})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{failure}");
    assert_eq!(failure["code"], "EMAIL_DELIVERY_FAILED");
    let id: String = sqlx::query_scalar(
        "SELECT id FROM invitation WHERE organization_id=$1 AND email=$2 AND status='pending'",
    )
    .bind(&workspace.id)
    .bind(&email)
    .fetch_one(&f.pool)
    .await
    .unwrap();
    assert!(f.mailbox.1.lock().unwrap().is_empty());
    f.mailbox
        .2
        .store(false, std::sync::atomic::Ordering::Relaxed);
    let (status, _, success) = f
        .request(
            "POST",
            "/api/workspace/invitations",
            Some(&cookie),
            Some(json!({"email":email,"role":"member","resend":true})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{success}");
    assert_eq!(success["invitation"]["id"], id);
    assert_eq!(success["invitation"]["role"], "admin");
    assert_eq!(f.mailbox.1.lock().unwrap().len(), 1);
    let (status, _, canceled) = f
        .request(
            "POST",
            "/api/workspace/invitations/cancel",
            Some(&cookie),
            Some(json!({"invitationId":id})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{canceled}");
    assert_eq!(canceled["status"], "canceled");
}

#[tokio::test]
async fn invitation_details_and_rejection_require_the_current_verified_recipient() {
    let f = Fixture::new().await;
    let (_, sender_token, sender_cookie) = f.account().await;
    let workspace = forge_store::workspaces::create(
        &f.database,
        &sender_token,
        "Recipient privacy",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let (recipient, _, cookie) = f.account().await;
    let actor = forge_store::authority::session_actor(&f.database, &sender_token)
        .await
        .unwrap();
    let invitation = forge_store::members::invite(
        &f.database,
        &actor,
        &forge_store::members::Invite {
            email: recipient.email,
            role: "member".into(),
            resend: false,
        },
    )
    .await
    .unwrap();
    let path = format!("/api/auth/organization/get-invitation?id={}", invitation.id);
    let (status, _, details) = f.request("GET", &path, Some(&cookie), None).await;
    assert_eq!(status, StatusCode::OK, "{details}");
    assert_eq!(details["organizationName"], workspace.name);
    assert!(details["inviterEmail"].is_string());
    let (status, _, _) = f.request("GET", &path, Some(&sender_cookie), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = f.request("GET", &path, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    sqlx::query("UPDATE \"user\" SET email_verified=false WHERE id=$1")
        .bind(&recipient.id)
        .execute(&f.pool)
        .await
        .unwrap();
    let (status, _, _) = f.request("GET", &path, Some(&cookie), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = f
        .request(
            "POST",
            "/api/auth/organization/reject-invitation",
            Some(&cookie),
            Some(json!({"invitationId":invitation.id})),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    sqlx::query("UPDATE \"user\" SET email_verified=true WHERE id=$1")
        .bind(&recipient.id)
        .execute(&f.pool)
        .await
        .unwrap();
    let (status, _, rejected) = f
        .request(
            "POST",
            "/api/auth/organization/reject-invitation",
            Some(&cookie),
            Some(json!({"invitationId":invitation.id})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{rejected}");
    assert_eq!(rejected["invitation"]["status"], "rejected");
    assert!(rejected["member"].is_null());
    let (status, _, _) = f.request("GET", &path, Some(&cookie), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

struct Fixture {
    pool: PgPool,
    database: forge_store::Database,
    app: Router,
    mailbox: Arc<Mailbox>,
}

impl Fixture {
    async fn new() -> Self {
        let connection =
            std::env::var("FORGE_RUST_TEST_DATABASE_URL").expect("Run bun run rewrite:verify");
        let options: sqlx::postgres::PgConnectOptions = connection.parse().unwrap();
        assert_eq!(options.get_host(), "127.0.0.1");
        assert_eq!(options.get_username(), "forge_rust_test");
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect_with(options)
            .await
            .unwrap();
        let mailbox = Arc::new(Mailbox::default());
        let state = AppState::configured(
            pool.clone(),
            AuthSettings::new(SECRET.into(), ORIGIN).unwrap(),
            Some(mailbox.clone()),
        );
        Self {
            database: forge_store::Database::new(pool.clone()),
            pool,
            app: forge_server::router_with_state(state),
            mailbox,
        }
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        cookie: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, HeaderMap, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::ORIGIN, ORIGIN);
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        let body = if let Some(body) = body {
            request = request.header(header::CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        } else {
            Body::empty()
        };
        let response = self
            .app
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, headers, body)
    }

    async fn account(&self) -> (User, String, String) {
        let email = format!("{}@example.test", Uuid::new_v4());
        let user = accounts::register_email_user(
            &self.database,
            "Test account",
            &email,
            None,
            "fixture-not-used-for-login",
        )
        .await
        .unwrap()
        .user;
        sqlx::query("UPDATE \"user\" SET email_verified=true WHERE id=$1")
            .bind(&user.id)
            .execute(&self.pool)
            .await
            .unwrap();
        let token = Uuid::new_v4().to_string();
        accounts::create_session(&self.database, &user.id, &token, true, None)
            .await
            .unwrap();
        let cookie = format!(
            "better-auth.session_token={}",
            forge_identity::sign_session_token(&token, SECRET).unwrap()
        );
        (user, token, cookie)
    }
}

#[tokio::test]
async fn signup_verify_login_create_workspace_and_logout_through_http() {
    let fixture = Fixture::new().await;
    let email = format!("{}@example.test", Uuid::new_v4());
    let password = "test-password-Å①";
    let (status, _, signup) = fixture
        .request(
            "POST",
            "/api/auth/sign-up/email",
            None,
            Some(json!({"name":"Ada","email":email,"password":password,"callbackURL":"/login"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{signup}");
    assert_eq!(signup["token"], Value::Null);
    assert_eq!(signup["user"]["emailVerified"], false);
    let (status, _, signin) = fixture
        .request(
            "POST",
            "/api/auth/sign-in/email",
            None,
            Some(json!({"email":email,"password":password})),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(signin["code"], "EMAIL_NOT_VERIFIED");
    let messages = fixture.mailbox.0.lock().unwrap().clone();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].0, email);
    let url = url::Url::parse(&messages[0].1).unwrap();
    let path = format!("{}?{}", url.path(), url.query().unwrap());
    let (status, headers, _) = fixture.request("GET", &path, None, None).await;
    assert_eq!(status, StatusCode::FOUND);
    assert_eq!(headers[header::LOCATION], "http://localhost:3100/login");
    let (status, headers, signin) = fixture
        .request(
            "POST",
            "/api/auth/sign-in/email",
            None,
            Some(json!({"email":email,"password":password,"rememberMe":true})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{signin}");
    assert_eq!(signin["user"]["emailVerified"], true);
    let cookie = headers
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let (status, headers, session) = fixture
        .request("GET", "/api/auth/get-session", Some(&cookie), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(session["user"]["id"], signup["user"]["id"]);
    let slug = format!("workspace-{}", Uuid::new_v4());
    let (status, _, workspace) = fixture
        .request(
            "POST",
            "/api/auth/organization/create",
            Some(&cookie),
            Some(json!({"name":"Test workspace","slug":slug})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{workspace}");
    let (status, _, workspaces) = fixture
        .request("GET", "/api/auth/organization/list", Some(&cookie), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(workspaces.as_array().unwrap().len(), 1);
    let (_, _, session) = fixture
        .request("GET", "/api/auth/get-session", Some(&cookie), None)
        .await;
    assert_eq!(session["session"]["activeOrganizationId"], workspace["id"]);
    let (status, headers, _) = fixture
        .request("POST", "/api/auth/sign-out", Some(&cookie), Some(json!({})))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        headers
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .contains("Max-Age=0")
    );
    assert_eq!(
        fixture
            .request("GET", "/api/auth/get-session", Some(&cookie), None)
            .await
            .2,
        Value::Null
    );
}

#[tokio::test]
async fn forged_cookies_cross_origin_writes_and_foreign_workspaces_are_denied() {
    let fixture = Fixture::new().await;
    let (_, _, cookie) = fixture.account().await;
    let (_, _, foreign_cookie) = fixture.account().await;
    let (status, _, workspace) = fixture
        .request(
            "POST",
            "/api/auth/organization/create",
            Some(&foreign_cookie),
            Some(json!({"name":"Private","slug":Uuid::new_v4().to_string()})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = fixture
        .request(
            "POST",
            "/api/auth/organization/set-active",
            Some(&cookie),
            Some(json!({"organizationId":workspace["id"]})),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, _) = fixture
        .request(
            "POST",
            "/api/auth/organization/create",
            Some("better-auth.session_token=unsigned"),
            Some(json!({"name":"Forged","slug":"forged"})),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let request = Request::post("/api/auth/sign-out")
        .header(header::ORIGIN, "https://untrusted.example")
        .header(header::COOKIE, &cookie)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .unwrap();
    let response = fixture.app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_ne!(
        fixture
            .request("GET", "/api/auth/get-session", Some(&cookie), None)
            .await
            .2,
        Value::Null
    );
}

#[tokio::test]
async fn deferred_refresh_updates_database_and_browser_cookie_only_on_post() {
    let fixture = Fixture::new().await;
    let (_, token, cookie) = fixture.account().await;
    sqlx::query("UPDATE session SET expires_at=now()+interval '1 hour',updated_at=now()-interval '1 day' WHERE token=$1").bind(&token).execute(&fixture.pool).await.unwrap();
    let (_, _, before) = fixture
        .request("GET", "/api/auth/get-session", Some(&cookie), None)
        .await;
    assert_eq!(before["needsRefresh"], true);
    let (status, headers, after) = fixture
        .request(
            "POST",
            "/api/auth/get-session",
            Some(&cookie),
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(
        before["session"]["expiresAt"],
        after["session"]["expiresAt"]
    );
    assert!(
        headers
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .contains("Max-Age=604800")
    );
}

#[tokio::test]
async fn accepting_an_invitation_into_a_full_workspace_rolls_back_every_effect() {
    let fixture = Fixture::new().await;
    let (owner, _, owner_cookie) = fixture.account().await;
    let (status, _, workspace) = fixture
        .request(
            "POST",
            "/api/auth/organization/create",
            Some(&owner_cookie),
            Some(json!({"name":"Full workspace","slug":Uuid::new_v4().to_string()})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let workspace_id = workspace["id"].as_str().unwrap();
    for _ in 0..4 {
        let (user, _, _) = fixture.account().await;
        sqlx::query(
            "INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'member')",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(workspace_id)
        .bind(user.id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    }
    let (invitee, token, cookie) = fixture.account().await;
    let invitation_id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO invitation(id,organization_id,email,role,status,expires_at,inviter_id) VALUES($1,$2,$3,'member','pending',now()+interval '2 days',$4)")
        .bind(&invitation_id).bind(workspace_id).bind(&invitee.email).bind(owner.id).execute(&fixture.pool).await.unwrap();
    let (status, _, error) = fixture
        .request(
            "POST",
            "/api/auth/organization/accept-invitation",
            Some(&cookie),
            Some(json!({"invitationId":invitation_id})),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["code"], "WORKSPACE_MEMBER_LIMIT");
    let state: String = sqlx::query_scalar("SELECT status FROM invitation WHERE id=$1")
        .bind(invitation_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(state, "pending");
    let active: Option<String> =
        sqlx::query_scalar("SELECT active_organization_id FROM session WHERE token=$1")
            .bind(token)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert!(active.is_none());
    let memberships: i64 =
        sqlx::query_scalar("SELECT count(*) FROM member WHERE organization_id=$1 AND user_id=$2")
            .bind(workspace_id)
            .bind(invitee.id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
    assert_eq!(memberships, 0);
}

#[test]
fn verification_template_preserves_markup_and_escapes_untrusted_fields() {
    let html = forge_server::mail::verification_html(
        "<script>FORGE_VERIFICATION_URL_MARKER</script>",
        "https://example.test/?a=1&b=2",
    );
    assert!(!html.contains("<script>"));
    assert!(html.contains("&lt;script&gt;FORGE_VERIFICATION_URL_MARKER&lt;/script&gt;"));
    assert!(html.contains("https://example.test/?a=1&amp;b=2"));
}

#[tokio::test]
async fn duplicate_signup_does_not_disclose_or_overwrite_an_existing_account() {
    let fixture = Fixture::new().await;
    let (existing, _, _) = fixture.account().await;
    let (status,_,result)=fixture.request("POST","/api/auth/sign-up/email",None,Some(json!({"name":"Different submitted name","email":existing.email,"password":"another-password"}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["token"], Value::Null);
    assert_ne!(result["user"]["id"], existing.id);
    assert_eq!(result["user"]["emailVerified"], false);
    assert_eq!(result["user"]["name"], "Different submitted name");
    let persisted = accounts::user_by_email(&fixture.database, &existing.email)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(persisted.name, existing.name);
    assert!(persisted.email_verified);
    assert!(fixture.mailbox.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn repeated_verification_links_do_not_change_profile_revisions() {
    let fixture = Fixture::new().await;
    let (user, _, _) = fixture.account().await;
    let before = accounts::user_by_email(&fixture.database, &user.email)
        .await
        .unwrap()
        .unwrap()
        .updated_at;
    assert!(
        accounts::verify_email(&fixture.database, &user.email)
            .await
            .unwrap()
    );
    let after = accounts::user_by_email(&fixture.database, &user.email)
        .await
        .unwrap()
        .unwrap()
        .updated_at;
    assert_eq!(before, after);
}

#[tokio::test]
async fn verification_requests_are_limited_before_a_provider_can_be_spammed() {
    let fixture = Fixture::new().await;
    let email = format!("{}@example.test", Uuid::new_v4());
    for _ in 0..3 {
        assert_eq!(
            fixture
                .request(
                    "POST",
                    "/api/auth/send-verification-email",
                    None,
                    Some(json!({"email":email}))
                )
                .await
                .0,
            StatusCode::OK
        );
    }
    assert_eq!(
        fixture
            .request(
                "POST",
                "/api/auth/send-verification-email",
                None,
                Some(json!({"email":email}))
            )
            .await
            .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert!(fixture.mailbox.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn simultaneous_session_revocations_settle_without_a_deadlock() {
    let fixture = Fixture::new().await;
    let (user, first, _) = fixture.account().await;
    let second = Uuid::new_v4().to_string();
    accounts::create_session(&fixture.database, &user.id, &second, true, None)
        .await
        .unwrap();
    let (first_result, second_result) = tokio::join!(
        accounts::revoke_session(&fixture.database, &first, &second),
        accounts::revoke_session(&fixture.database, &second, &first)
    );
    assert!(first_result.is_ok() || second_result.is_ok());
    for result in [first_result, second_result] {
        assert!(result.is_ok() || matches!(result, Err(forge_store::StoreError::Unauthenticated)));
    }
}

#[tokio::test]
async fn workspace_update_and_cascading_deletion_use_a_consistent_lock_order() {
    let fixture = Fixture::new().await;
    let (owner, owner_token, owner_cookie) = fixture.account().await;
    let (_, _, workspace) = fixture
        .request(
            "POST",
            "/api/auth/organization/create",
            Some(&owner_cookie),
            Some(json!({"name":"Concurrent workspace","slug":Uuid::new_v4().to_string()})),
        )
        .await;
    let id = workspace["id"].as_str().unwrap();
    let (admin, admin_token, _) = fixture.account().await;
    sqlx::query("INSERT INTO member(id,organization_id,user_id,role) VALUES($1,$2,$3,'admin')")
        .bind(Uuid::new_v4().to_string())
        .bind(id)
        .bind(&admin.id)
        .execute(&fixture.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE session SET active_organization_id=$1 WHERE token=$2")
        .bind(id)
        .bind(&admin_token)
        .execute(&fixture.pool)
        .await
        .unwrap();
    let (updated, deleted) = tokio::join!(
        forge_store::workspaces::update(
            &fixture.database,
            &admin_token,
            id,
            Some("Changed"),
            None,
            None
        ),
        forge_store::workspaces::delete(&fixture.database, &owner_token, id)
    );
    assert!(updated.is_ok() || matches!(updated, Err(forge_store::StoreError::Forbidden)));
    assert!(deleted.is_ok(), "{deleted:?}");
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM organization WHERE id=$1)")
        .bind(id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert!(!exists);
    let owner_session = accounts::session_and_user(&fixture.database, &owner_token, false, true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(owner_session.0.active_organization_id, None);
    assert_eq!(owner_session.1.id, owner.id);
}
