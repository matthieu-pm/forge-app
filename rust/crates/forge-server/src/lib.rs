//! Rust HTTP host. Routes are enabled only as their implementation is migrated.

mod auth;
mod desktop_auth;
pub mod mail;
mod oauth;
pub mod oauth_provider;
pub mod state;
mod workspace_access;
mod workspaces;

use axum::{
    Json, Router,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::json;

pub fn router() -> Router {
    router_with_state(state::AppState::default())
}

pub fn router_with_state(state: state::AppState) -> Router {
    let auth_routes = Router::new()
        .route(
            "/api/workspace/security",
            get(workspace_access::security_snapshot).post(workspace_access::security_command),
        )
        .route("/api/workspace/members", get(workspace_access::access))
        .route(
            "/api/workspace/members/change",
            axum::routing::post(workspace_access::change_member),
        )
        .route(
            "/api/workspace/invitations",
            axum::routing::post(workspace_access::invite),
        )
        .route(
            "/api/workspace/invitations/cancel",
            axum::routing::post(workspace_access::cancel_invite),
        )
        .route(
            "/api/workspace/api-keys",
            get(workspace_access::list_keys).post(workspace_access::create_key),
        )
        .route(
            "/api/workspace/api-keys/policy",
            get(workspace_access::key_policy),
        )
        .route(
            "/api/workspace/api-keys/revoke",
            axum::routing::post(workspace_access::revoke_key),
        )
        .route(
            "/api/workspace/invite-preview",
            get(workspace_access::preview_invite),
        )
        .route(
            "/api/workspace/join-invite",
            axum::routing::post(workspace_access::join_invite),
        )
        .route(
            "/api/workspace/approved-domain",
            get(workspace_access::approved_domain),
        )
        .route(
            "/api/workspace/join-domain",
            axum::routing::post(workspace_access::join_domain),
        )
        .route(
            "/api/auth/electron/init-oauth-proxy",
            get(desktop_auth::init_oauth_proxy),
        )
        .route(
            "/api/auth/electron/transfer-user",
            axum::routing::post(desktop_auth::transfer_user),
        )
        .route(
            "/api/auth/electron/token",
            axum::routing::post(desktop_auth::redeem),
        )
        .route(
            "/api/auth/sign-in/social",
            axum::routing::post(oauth::sign_in),
        )
        .route("/api/auth/link-social", axum::routing::post(oauth::link))
        .route("/api/auth/callback/chatgpt", get(oauth::callback))
        .route("/api/auth/sign-up/email", axum::routing::post(auth::signup))
        .route("/api/auth/sign-in/email", axum::routing::post(auth::signin))
        .route(
            "/api/auth/get-session",
            get(auth::get_session).post(auth::refresh_session),
        )
        .route("/api/auth/sign-out", axum::routing::post(auth::signout))
        .route("/api/auth/verify-email", get(auth::verify_email))
        .route(
            "/api/auth/send-verification-email",
            axum::routing::post(auth::send_verification),
        )
        .route("/api/auth/list-sessions", get(auth::list_sessions))
        .route(
            "/api/auth/revoke-session",
            axum::routing::post(auth::revoke_session),
        )
        .route(
            "/api/auth/update-user",
            axum::routing::post(auth::update_user_denied),
        )
        .route(
            "/api/auth/organization/create",
            axum::routing::post(workspaces::create),
        )
        .route("/api/auth/organization/list", get(workspaces::list))
        .route(
            "/api/auth/organization/check-slug",
            axum::routing::post(workspaces::check_slug),
        )
        .route(
            "/api/auth/organization/set-active",
            axum::routing::post(workspaces::set_active),
        )
        .route(
            "/api/auth/organization/update",
            axum::routing::post(workspaces::update),
        )
        .route(
            "/api/auth/organization/delete",
            axum::routing::post(workspaces::delete),
        )
        .route(
            "/api/auth/organization/accept-invitation",
            axum::routing::post(workspaces::accept_invitation),
        )
        .route(
            "/api/auth/organization/get-invitation",
            get(workspaces::invitation_details),
        )
        .route(
            "/api/auth/organization/reject-invitation",
            axum::routing::post(workspaces::reject_invitation),
        )
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::guard,
        ));
    Router::new()
        .route("/api/health/live", get(live))
        .route("/api/health/ready", get(ready))
        .merge(auth_routes)
        .with_state(state)
}

fn health_response(code: &str, status: StatusCode) -> Response {
    (
        status,
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        Json(json!({"status": if status.is_success() { "ok" } else { "unhealthy" }, "code": code})),
    )
        .into_response()
}

async fn live() -> Response {
    health_response("ALIVE", StatusCode::OK)
}

async fn ready() -> Response {
    // A listening HTTP socket is not evidence that the product is ready.
    health_response("CONFIGURATION_INVALID", StatusCode::SERVICE_UNAVAILABLE)
}
