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

#[tokio::test]
async fn document_http_supports_rich_depth_large_unicode_history_and_bound_session_context() {
    let f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "Document HTTP",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &token)
        .await
        .unwrap();
    let forge_core::actor::Authentication::Session { session_id } = actor.authentication else {
        panic!("session")
    };
    let bind = |mut v: Value| {
        v["workspaceId"] = json!(actor.workspace_id);
        v["sessionId"] = json!(session_id);
        v
    };
    let id = Uuid::new_v4();
    let mut body = json!({"type":"paragraph"});
    for _ in 1..64 {
        body = json!({"type":"blockquote","content":[body]});
    }
    body = json!({"type":"doc","content":[body]});
    let fields =
        json!({"title":"Deep document","body":body,"icon":forge_core::documents::default_icon()});
    let input = bind(
        json!({"commandKey":Uuid::new_v4(),"command":{"action":"create","id":id,"source":{"kind":"workspace"},"fields":fields}}),
    );
    let (status, _, saved) = f
        .request(
            "POST",
            "/api/workspace/documents",
            Some(&cookie),
            Some(input.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["revision"], 1);
    let (status, _, rows) = f
        .request(
            "POST",
            "/api/workspace/documents/read",
            Some(&cookie),
            Some(bind(json!({"id":id}))),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{rows}");
    assert_eq!(rows[0]["body"], body);
    let (status, _, history) = f
        .request(
            "POST",
            "/api/workspace/documents/history",
            Some(&cookie),
            Some(bind(json!({"id":id}))),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{history}");
    assert_eq!(history[0]["body"], body);
    let (status, _, shared) = f
        .request(
            "POST",
            "/api/workspace/documents/share",
            Some(&cookie),
            Some(bind(json!({"id":id,"shared":true}))),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{shared}");
    assert_eq!(shared["id"], id.to_string());
    let mut wrong = input.clone();
    wrong["sessionId"] = json!("other-session");
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/documents",
            Some(&cookie),
            Some(wrong)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let mut invalid = input.clone();
    invalid["command"]["fields"]["body"] = json!({"type":"script"});
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/documents",
            Some(&cookie),
            Some(invalid)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let mut large = input;
    large["commandKey"] = json!(Uuid::new_v4());
    large["command"]["id"] = json!(Uuid::new_v4());
    large["command"]["fields"]["body"] = json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"☃".repeat(710_000)}]}]});
    let (status, _, saved) = f
        .request(
            "POST",
            "/api/workspace/documents",
            Some(&cookie),
            Some(large),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
}

#[tokio::test]
async fn saved_view_and_resource_http_enforce_identity_and_expose_shared_state() {
    let f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "Views HTTP",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &token)
        .await
        .unwrap();
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Resources","identifier":"RES","icon":{"kind":"emoji","value":"🛠️","color":"#818cf8"},"timezone":"UTC"})).unwrap()).await.unwrap();
    let forge_core::actor::Authentication::Session { session_id } = &actor.authentication else {
        panic!("session")
    };
    let bind = |mut v: Value| {
        v["workspaceId"] = json!(actor.workspace_id);
        v["sessionId"] = json!(session_id);
        v
    };
    let (status,_,saved)=f.request("POST","/api/workspace/team-resources",Some(&cookie),Some(bind(json!({"commandKey":Uuid::new_v4(),"command":{"teamId":team.id,"expectedRevision":0,"fields":{"sections":[],"links":[],"order":[]}}})))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["revision"], 1);
    let (status, _, board) = f
        .request(
            "POST",
            "/api/workspace/team-resources/read",
            Some(&cookie),
            Some(bind(json!({"teamId":team.id}))),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{board}");
    assert_eq!(board["revision"], 1);
    let id = Uuid::new_v4();
    let definition = json!({"version":1,"name":"View","description":"","icon":null,"visibility":"workspace","kind":"projects","filters":[],"display":forge_core::saved_views::default_project_display()});
    let (status,_,saved)=f.request("POST","/api/workspace/views",Some(&cookie),Some(bind(json!({"commandKey":Uuid::new_v4(),"mutation":{"action":"save","id":id,"expectedRevision":null,"definition":definition}})))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["value"]["revision"], 1);
    let (status, _, directory) = f
        .request(
            "POST",
            "/api/workspace/views/read",
            Some(&cookie),
            Some(bind(json!({}))),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{directory}");
    assert_eq!(directory["views"][0]["id"], id.to_string());
    let (status, _, query) = f
        .request(
            "POST",
            "/api/workspace/views/projects",
            Some(&cookie),
            Some(bind(json!({"definition":definition}))),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{query}");
    assert_eq!(query, json!({"projects":[],"authorizedProjectIds":[]}));
    let mut wrong = bind(json!({}));
    wrong["workspaceId"] = json!("other-workspace");
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/views/read",
            Some(&cookie),
            Some(wrong)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/views/read",
            Some(&cookie),
            Some(bind(json!({"unexpected":true})))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn product_state_http_preserves_private_large_values_and_current_session_binding() {
    let f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "State HTTP",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let (status, _, snapshot) = f
        .request("GET", "/api/workspace/product-state", Some(&cookie), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{snapshot}");
    let key = "forge:desktop-tabs";
    let value = "☃".repeat(710_000);
    let input = json!({"workspaceId":snapshot["workspaceId"],"sessionId":snapshot["sessionId"],"commandKey":Uuid::new_v4(),"key":key,"value":value,"expectedRevision":0});
    let (status, _, saved) = f
        .request(
            "POST",
            "/api/workspace/product-state",
            Some(&cookie),
            Some(input.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["value"]["revision"], 1);
    let (status, _, snapshot) = f
        .request("GET", "/api/workspace/product-state", Some(&cookie), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        snapshot["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["key"] == key)
            .unwrap()["value"],
        value
    );
    let mut wrong = input;
    wrong["sessionId"] = json!("previous-session");
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/product-state",
            Some(&cookie),
            Some(wrong)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn issue_http_commands_preserve_bound_sessions_and_expose_discussion_and_history() {
    let f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "Issue HTTP",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &token)
        .await
        .unwrap();
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Issues","identifier":"ISS","icon":{"kind":"emoji","value":"🛠️","color":"#818cf8"},"timezone":"UTC"})).unwrap()).await.unwrap();
    let (status, _, snapshot) = f
        .request("GET", "/api/workspace/issues", Some(&cookie), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{snapshot}");
    assert_eq!(snapshot["records"], json!([]));
    let bind = |mut value: Value| {
        value["workspaceId"] = snapshot["workspaceId"].clone();
        value["sessionId"] = snapshot["sessionId"].clone();
        value
    };
    let mut draft = forge_core::issues::blank("todo");
    draft["title"] = json!("HTTP issue");
    let input = bind(json!({"teamId":team.id,"commandKey":Uuid::new_v4(),"draft":draft}));
    let (status, _, created) = f
        .request(
            "POST",
            "/api/workspace/issues",
            Some(&cookie),
            Some(input.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["issue"]["title"], "HTTP issue");
    let mut wrong = input;
    wrong["sessionId"] = json!("different-session");
    assert_eq!(
        f.request("POST", "/api/workspace/issues", Some(&cookie), Some(wrong))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let input = bind(
        json!({"teamId":team.id,"commandKey":Uuid::new_v4(),"edits":[{"issueId":created["issue"]["id"],"expectedRevision":created["issue"]["revision"],"changes":{"title":"HTTP updated"}}]}),
    );
    let (status, _, edited) = f
        .request(
            "POST",
            "/api/workspace/issues/edit",
            Some(&cookie),
            Some(input),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    assert_eq!(edited["status"], "saved");
    let input = bind(
        json!({"teamId":team.id,"issueId":created["issue"]["id"],"commandKey":Uuid::new_v4(),"commentId":Uuid::new_v4(),"action":"create","document":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"HTTP comment"}]}]}}),
    );
    let (status, _, comment) = f
        .request(
            "POST",
            "/api/workspace/issues/comment",
            Some(&cookie),
            Some(input),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{comment}");
    assert_eq!(comment["status"], "saved");
    let (status, _, history) = f
        .request(
            "POST",
            "/api/workspace/issues/history",
            Some(&cookie),
            Some(bind(json!({"query":{"issueId":created["issue"]["id"]}}))),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{history}");
    assert_eq!(history["entries"].as_array().unwrap().len(), 3);
    let (status, _, page) = f
        .request(
            "POST",
            "/api/workspace/issues/query",
            Some(&cookie),
            Some(bind(json!({"query":{"search":"HTTP updated","limit":1}}))),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["total"], 1);
    assert_eq!(page["records"][0]["issue"]["id"], created["issue"]["id"]);
    let project = Uuid::new_v4();
    let (status,_,saved)=f.request("POST","/api/workspace/projects",Some(&cookie),Some(bind(json!({"commandKey":Uuid::new_v4(),"changes":[{"id":project,"expectedRevision":null,"changes":{"name":"HTTP project","teamIds":[team.id]}}]})))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let (status, _, projects) = f
        .request("GET", "/api/workspace/projects", Some(&cookie), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{projects}");
    assert_eq!(projects["projects"][0]["id"], project.to_string());
    let mut project_statuses = forge_core::projects::initial_statuses();
    project_statuses["version"] = json!(1);
    let (status,_,saved)=f.request("POST","/api/workspace/project-catalog",Some(&cookie),Some(bind(json!({"kind":"statuses","commandKey":Uuid::new_v4(),"expectedRevision":0,"value":project_statuses.to_string()})))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let (status, _, catalog) = f
        .request("GET", "/api/workspace/project-catalog", Some(&cookie), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{catalog}");
    assert_eq!(catalog["statusesRevision"], 1);
    let mut wrong = bind(json!({"commandKey":Uuid::new_v4(),"changes":[]}));
    wrong["sessionId"] = json!("wrong");
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/projects",
            Some(&cookie),
            Some(wrong)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let initiative = Uuid::new_v4();
    let (status,_,saved)=f.request("POST","/api/workspace/initiatives",Some(&cookie),Some(bind(json!({"commandKey":Uuid::new_v4(),"changes":[{"id":initiative,"expectedRevision":null,"changes":{"name":"HTTP initiative"},"addProjectIds":[project]}]})))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let (status, _, snapshot) = f
        .request("GET", "/api/workspace/initiatives", Some(&cookie), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{snapshot}");
    assert_eq!(
        snapshot["initiatives"][0]["projects"][0]["id"],
        project.to_string()
    );
    let (status, _, planning_page) = f
        .request(
            "POST",
            "/api/workspace/planning/list",
            Some(&cookie),
            Some(bind(json!({"kind":"initiative","query":{"limit":1}}))),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{planning_page}");
    assert_eq!(planning_page["items"][0]["id"], initiative.to_string());
    let (status,_,saved)=f.request("POST","/api/workspace/initiative-settings",Some(&cookie),Some(bind(json!({"commandKey":Uuid::new_v4(),"expectedRevision":0,"value":"{\"enabled\":false,\"schedule\":\"none\"}"})))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let (status, _, snapshot) = f
        .request("GET", "/api/workspace/initiatives", Some(&cookie), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{snapshot}");
    assert_eq!(snapshot["initiatives"], json!([]));
    let mut cycle_settings = forge_core::cycles::initial();
    cycle_settings["enabled"] = json!(true);
    let (status,_,saved)=f.request("POST","/api/workspace/team-settings",Some(&cookie),Some(bind(json!({"teamId":team.id,"kind":"cycles","commandKey":Uuid::new_v4(),"expectedRevision":0,"value":cycle_settings.to_string()})))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let (status, _, cycles) = f
        .request(
            "POST",
            "/api/workspace/cycles",
            Some(&cookie),
            Some(bind(json!({"teamId":team.id}))),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{cycles}");
    assert_eq!(cycles["cycles"].as_array().unwrap().len(), 2);
    let (status, _, triage) = f
        .request(
            "POST",
            "/api/workspace/triage",
            Some(&cookie),
            Some(bind(json!({"teamId":team.id}))),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{triage}");
    assert_eq!(triage["settings"]["enabled"], false);
    let (status,_,archived)=f.request("POST","/api/workspace/issues/lifecycle",Some(&cookie),Some(bind(json!({"teamId":team.id,"issueId":created["issue"]["id"],"commandKey":Uuid::new_v4(),"expectedRevision":page["records"][0]["issue"]["revision"],"action":"archive"})))).await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    assert_eq!(archived["value"]["active"], false);
    let (status, _, inactive) = f
        .request(
            "POST",
            "/api/workspace/issues/inactive",
            Some(&cookie),
            Some(bind(json!({"teamId":team.id,"kind":"archived"}))),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{inactive}");
    assert_eq!(inactive["items"][0]["id"], created["issue"]["id"]);
    let mut wrong = bind(json!({"query":{}}));
    wrong["workspaceId"] = json!("another-workspace");
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/issues/query",
            Some(&cookie),
            Some(wrong)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/issues/query",
            Some(&cookie),
            Some(bind(json!({"query":{"limit":101}})))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn definition_http_routes_bind_sessions_validate_catalogs_and_surface_conflicts() {
    let f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "Definition HTTP",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &token)
        .await
        .unwrap();
    let team=forge_store::teams::create(&f.database,&actor,&forge_core::teams::CreateTeam::parse(json!({"name":"Definitions","identifier":"DEF","icon":{"kind":"emoji","value":"🛠️","color":"#818cf8"},"timezone":"UTC"})).unwrap()).await.unwrap();
    let path = "/api/workspace/issue-definitions";
    assert_eq!(
        f.request("GET", path, None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (status, _, all) = f.request("GET", path, Some(&cookie), None).await;
    assert_eq!(status, StatusCode::OK, "{all}");
    let snapshot = all["snapshots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["teamId"] == team.id.to_string())
        .unwrap();
    let mut value = snapshot["value"].clone();
    value["statuses"]["defaultId"] = json!("todo");
    let input = json!({"workspaceId":all["workspaceId"],"sessionId":all["sessionId"],"teamId":team.id,"commandKey":Uuid::new_v4().to_string(),"expectedRevision":0,"value":value});
    let (status, _, saved) = f
        .request("POST", path, Some(&cookie), Some(input.clone()))
        .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["revision"], 1);
    let mut conflict = input.clone();
    conflict["commandKey"] = json!(Uuid::new_v4());
    let (status, _, error) = f.request("POST", path, Some(&cookie), Some(conflict)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert_eq!(error["code"], "DEFINITION_CONFLICT");
    let mut invalid = input.clone();
    invalid.as_object_mut().unwrap().remove("teamId");
    assert_eq!(
        f.request("POST", path, Some(&cookie), Some(invalid))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let mut invalid = input.clone();
    invalid["value"]["transitions"] = json!({"missing":["todo"]});
    assert_eq!(
        f.request("POST", path, Some(&cookie), Some(invalid))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let mut invalid = input;
    invalid["sessionId"] = json!("not-this-session");
    assert_eq!(
        f.request("POST", path, Some(&cookie), Some(invalid))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let issue = Uuid::new_v4();
    sqlx::query("INSERT INTO issues(id,workspace_id,team_id,number,title,status_id) VALUES($1,$2,$3,1,'HTTP classification','backlog')").bind(issue).bind(&actor.workspace_id).bind(team.id).execute(&f.pool).await.unwrap();
    let input = json!({"issueId":issue,"commandKey":Uuid::new_v4().to_string(),"expectedStatusId":"backlog","statusId":"todo","labelIds":[]});
    let (status, _, result) = f
        .request(
            "POST",
            "/api/workspace/issues/classification",
            Some(&cookie),
            Some(input),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["issueId"], issue.to_string());
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
        )
        .with_public_api(true);
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
            forge_core::json::parse(std::str::from_utf8(&bytes).unwrap()).unwrap()
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
    async fn api(
        &self,
        method: &str,
        path: &str,
        key: Option<&str>,
        idempotency: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, HeaderMap, Value) {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(key) = key {
            request = request.header(header::AUTHORIZATION, format!("Bearer {key}"));
        }
        if let Some(key) = idempotency {
            request = request.header("idempotency-key", key);
        }
        let payload = if let Some(body) = body {
            request = request.header(header::CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        } else {
            Body::empty()
        };
        let response = self
            .app
            .clone()
            .oneshot(request.body(payload).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
        (status, headers, value)
    }
}

#[tokio::test]
async fn team_public_api_keeps_bearer_authentication_receipts_and_openapi_contracts() {
    let f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "API teams",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let (status, _, created) = f
        .request(
            "POST",
            "/api/workspace/api-keys",
            Some(&cookie),
            Some(json!({"name":"Team writer","scopes":["teams:read","teams:write"]})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let key = created["key"].as_str().unwrap();
    let (status, headers, denied) = f.api("GET", "/api/v1/teams", None, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(denied["defined"], true);
    assert_eq!(denied["code"], "UNAUTHORIZED");
    assert!(Uuid::parse_str(headers["x-request-id"].to_str().unwrap()).is_ok());
    let (status, _, _) = f.request("GET", "/api/v1/teams", Some(&cookie), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let input = json!({"name":"Platform","identifier":"PLAT","icon":{"kind":"emoji","value":"🛠️","color":"#818cf8"},"timezone":"Europe/Paris"});
    let (status, _, _) = f
        .api(
            "POST",
            "/api/v1/teams",
            Some(key),
            None,
            Some(input.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, headers, team) = f
        .api(
            "POST",
            "/api/v1/teams",
            Some(key),
            Some("platform-create"),
            Some(input.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{team}");
    assert_eq!(headers["cache-control"], "no-store");
    assert_eq!(team["slug"], "platform");
    let (status, _, replay) = f
        .api(
            "POST",
            "/api/v1/teams",
            Some(key),
            Some("platform-create"),
            Some(input.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{replay}");
    assert_eq!(team, replay);
    let mut changed = input;
    changed["name"] = json!("Other platform");
    let (status, _, conflict) = f
        .api(
            "POST",
            "/api/v1/teams",
            Some(key),
            Some("platform-create"),
            Some(changed),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["data"]["reason"], "IDEMPOTENCY_KEY_REUSED");
    let path = format!("/api/v1/teams/{}", team["id"].as_str().unwrap());
    let (status, _, updated) = f
        .api(
            "PATCH",
            &path,
            Some(key),
            None,
            Some(json!({"settings":{"name":"Renamed platform","description":"Core systems"}})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["slug"], "platform");
    assert_eq!(updated["name"], "Renamed platform");
    let (status, _, listed) = f
        .api("GET", "/api/v1/teams?limit=1", Some(key), None, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
    let (status, _, bad_cursor) = f
        .api(
            "GET",
            "/api/v1/teams?cursor=not-json",
            Some(key),
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{bad_cursor}");
    let (status, _, archived) = f.api("DELETE", &path, Some(key), None, None).await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    assert!(archived["recoverableUntil"].is_string());
    let (status, _, _) = f.api("GET", &path, Some(key), None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, spec) = f.api("GET", "/api/v1/openapi.json", None, None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(spec["openapi"], "3.1.1");
    assert!(spec["paths"]["/teams"]["post"].is_object());
    assert!(spec["paths"]["/issues"].is_null());
    let (status, _, docs) = f.api("GET", "/api/v1/docs", None, None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(docs.as_str().unwrap().contains("Scalar.createApiReference"));
}

#[tokio::test]
async fn first_party_team_lifecycle_keeps_names_confirmations_and_memberships() {
    let f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "Team lifecycle",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let input = json!({"name":" Équipe produit ","identifier":" prod ","icon":{"kind":"icon","value":"UserGroup03Icon","color":"#818cf8"},"timezone":"Europe/Paris"});
    let (status, _, created) = f
        .request("POST", "/api/workspace/teams", Some(&cookie), Some(input))
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["team"]["slug"], "equipe-produit");
    assert_eq!(created["team"]["identifier"], "PROD");
    let (status, _, directory) = f
        .request(
            "GET",
            "/api/workspace/team-directory?lifecycle=active",
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{directory}");
    assert_eq!(directory["items"][0]["memberCount"], 1);
    assert_eq!(directory["items"][0]["isMember"], true);
    let (status, _, wrong) = f
        .request(
            "POST",
            "/api/workspace/teams/equipe-produit/archive",
            Some(&cookie),
            Some(json!({"confirmationName":"Wrong"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(wrong["ok"], false);
    let (status, _, archived) = f
        .request(
            "POST",
            "/api/workspace/teams/equipe-produit/archive",
            Some(&cookie),
            Some(json!({"confirmationName":"Équipe produit"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    assert_eq!(archived["ok"], true);
    let (status, _, gone) = f
        .request(
            "GET",
            "/api/workspace/teams/equipe-produit",
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(gone.is_null());
    let (status, _, restored) = f
        .request(
            "POST",
            "/api/workspace/teams/equipe-produit/restore",
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(restored["team"]["id"], created["team"]["id"]);
    let (status, _, left) = f
        .request(
            "POST",
            "/api/workspace/teams/equipe-produit/leave",
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{left}");
    assert_eq!(left["ok"], true);
    let (status, _, joined) = f
        .request(
            "POST",
            "/api/workspace/teams/equipe-produit/join",
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{joined}");
    assert_eq!(joined["ok"], true);
    let (status, _, members) = f
        .request(
            "GET",
            "/api/workspace/teams/equipe-produit/members",
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{members}");
    assert_eq!(members["members"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn disabled_public_api_hides_resources_and_documentation() {
    let state = AppState::default().with_public_api(false);
    let app = forge_server::router_with_state(state);
    for path in ["/api/v1/teams", "/api/v1/openapi.json", "/api/v1/docs"] {
        let response = app
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
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

#[tokio::test]
async fn preferences_http_binds_sessions_and_handles_gated_fields_without_partial_writes() {
    let f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "Preferences HTTP",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let actor = forge_store::authority::session_actor(&f.database, &token)
        .await
        .unwrap();
    let session = match &actor.authentication {
        forge_core::actor::Authentication::Session { session_id } => session_id,
        _ => unreachable!(),
    };
    let (status, _, value) = f
        .request("GET", "/api/workspace/preferences", Some(&cookie), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["status"], "ready");
    let input = json!({"sessionId":session,"commandKey":Uuid::new_v4(),"version":1.0,"patch":{"general.interfaceTheme":"dark"},"expectedVersions":{"general.interfaceTheme":0}});
    let (status, _, value) = f
        .request(
            "POST",
            "/api/workspace/preferences",
            Some(&cookie),
            Some(input.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(
        value["snapshot"]["values"]["general.interfaceTheme"],
        "dark"
    );
    let mut wrong = input;
    wrong["sessionId"] = json!("previous-login");
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/preferences",
            Some(&cookie),
            Some(wrong)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let gated = json!({"sessionId":session,"commandKey":Uuid::new_v4(),"version":1,"patch":{"agent.guidance":"Original guidance","general.fontSize":"large"},"expectedVersions":{"agent.guidance":0,"general.fontSize":0}});
    let (status, _, value) = f
        .request(
            "POST",
            "/api/workspace/preferences",
            Some(&cookie),
            Some(gated),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["status"], "unavailable");
    assert!(
        value["snapshot"]["values"]
            .get("general.fontSize")
            .is_none()
    );
    let (status, _, value) = f
        .request(
            "POST",
            "/api/workspace/people",
            Some(&cookie),
            Some(json!({"sessionId":session,"workspaceId":actor.workspace_id})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["people"].as_array().unwrap().len(), 1);
    assert!(value["people"][0].get("email").is_none());
    let(status,_,value)=f.request("POST","/api/workspace/preference-imports",Some(&cookie),Some(json!({"sessionId":session,"workspaceId":actor.workspace_id,"userId":actor.user_id}))).await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["status"], "disabled");
}

#[tokio::test]
async fn imports_http_binds_private_previews_to_the_active_session() {
    let f = Fixture::new().await;
    let (_, token, cookie) = f.account().await;
    forge_store::workspaces::create(
        &f.database,
        &token,
        "Import HTTP",
        &Uuid::new_v4().to_string(),
        None,
    )
    .await
    .unwrap();
    let (_, _, state) = f
        .request("GET", "/api/workspace/product-state", Some(&cookie), None)
        .await;
    let identity = json!({"workspaceId":state["workspaceId"],"sessionId":state["sessionId"]});
    let (status, _, value) = f
        .request(
            "POST",
            "/api/workspace/imports/prepare",
            Some(&cookie),
            Some(identity.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert!(value.is_null());
    let (status, _, value) = f
        .request(
            "POST",
            "/api/workspace/imports",
            Some(&cookie),
            Some(identity.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value, json!([]));
    let mut wrong = identity.clone();
    wrong["sessionId"] = json!("old-session");
    assert_eq!(
        f.request(
            "POST",
            "/api/workspace/imports/prepare",
            Some(&cookie),
            Some(wrong)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.request("POST", "/api/workspace/imports", None, Some(identity))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}
