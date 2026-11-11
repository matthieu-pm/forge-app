//! Rust HTTP host. Routes are enabled only as their implementation is migrated.

pub mod agent_runtime;
mod auth;
mod definitions;
mod desktop_auth;
mod documents;
pub mod files;
mod imports;
mod issues;
pub mod mail;
pub mod model_providers;
pub mod model_proxy;
mod oauth;
pub mod oauth_provider;
mod planning;
mod preferences;
mod product_state;
mod profiles;
mod projects;
mod public_api;
pub mod retention;
pub mod sla;
pub mod state;
mod teams;
mod views;
mod workspace_access;
mod workspaces;

use axum::{
    Json, Router,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::json;

pub fn router() -> Router {
    router_with_state(state::AppState::default())
}

pub fn router_with_state(state: state::AppState) -> Router {
    let auth_routes = Router::new()
        .route(
            "/api/account/profile",
            get(profiles::read)
                .post(profiles::patch)
                .layer(axum::extract::DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        .route("/api/workspace/sla", post(sla::read))
        .route("/api/workspace/sla/save", post(sla::save))
        .route("/api/workspace/sla/reconcile", post(sla::reconcile))
        .route("/api/workspace/imports", post(imports::read))
        .route("/api/workspace/imports/prepare", post(imports::prepare))
        .route("/api/workspace/imports/read", post(imports::read_one))
        .route("/api/workspace/imports/batch", post(imports::batch))
        .route("/api/workspace/imports/choose", post(imports::choose))
        .route("/api/workspace/imports/file", post(imports::file))
        .route("/api/workspace/imports/retry", post(imports::retry))
        .route("/api/workspace/imports/pause", post(imports::pause))
        .route("/api/workspace/imports/cutover", post(imports::cutover))
        .route("/api/workspace/imports/report", post(imports::report))
        .merge(
            Router::new()
                .route(
                    "/api/workspace/preferences",
                    get(preferences::read).post(preferences::patch),
                )
                .route("/api/workspace/people", post(preferences::directory))
                .route(
                    "/api/workspace/preference-imports",
                    post(preferences::imports),
                )
                .route(
                    "/api/workspace/preference-imports/prepare",
                    post(preferences::prepare),
                )
                .route(
                    "/api/workspace/preference-imports/apply",
                    post(preferences::apply),
                )
                .layer(axum::extract::DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .merge(
            Router::new()
                .route(
                    "/api/workspace/product-state",
                    get(product_state::read).post(product_state::save),
                )
                .layer(axum::extract::DefaultBodyLimit::max(128 * 1024 * 1024)),
        )
        .route("/api/workspace/team-resources", post(views::save_resources))
        .route("/api/workspace/team-resources/read", post(views::resources))
        .route("/api/workspace/views", post(views::mutate))
        .route("/api/workspace/views/read", post(views::read))
        .route("/api/workspace/views/projects", post(views::query))
        .merge(
            Router::new()
                .route("/api/workspace/documents", post(documents::write))
                .route("/api/workspace/documents/read", post(documents::read))
                .route("/api/workspace/documents/history", post(documents::history))
                .route("/api/workspace/documents/share", post(documents::share))
                .layer(axum::extract::DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route(
            "/api/workspace/initiatives",
            get(planning::initiatives).post(planning::save_initiatives),
        )
        .route(
            "/api/workspace/initiative-settings",
            get(planning::settings).post(planning::save_settings),
        )
        .route("/api/workspace/planning/list", post(planning::list))
        .route("/api/workspace/planning/get", post(planning::get))
        .route("/api/workspace/planning/rollup", post(planning::rollup))
        .route("/api/workspace/planning/related", post(planning::related))
        .route(
            "/api/workspace/projects",
            get(projects::read).post(projects::save),
        )
        .route(
            "/api/workspace/project-catalog",
            get(projects::catalog).post(projects::save_catalog),
        )
        .route(
            "/api/workspace/team-settings",
            axum::routing::post(issues::save_team_settings),
        )
        .route("/api/workspace/cycles", axum::routing::post(issues::cycles))
        .route("/api/workspace/triage", axum::routing::post(issues::triage))
        .route(
            "/api/workspace/issues",
            get(issues::read).post(issues::create),
        )
        .route(
            "/api/workspace/issues/query",
            axum::routing::post(issues::query),
        )
        .route(
            "/api/workspace/issues/lifecycle",
            axum::routing::post(issues::lifecycle),
        )
        .route(
            "/api/workspace/issues/inactive",
            axum::routing::post(issues::inactive),
        )
        .route(
            "/api/workspace/issues/edit",
            axum::routing::post(issues::edit),
        )
        .route(
            "/api/workspace/issues/comment",
            axum::routing::post(issues::comment),
        )
        .route(
            "/api/workspace/issues/mentions",
            axum::routing::post(issues::mentions),
        )
        .route(
            "/api/workspace/issues/engagement",
            axum::routing::post(issues::engagement),
        )
        .route(
            "/api/workspace/issues/history",
            axum::routing::post(issues::history),
        )
        .route(
            "/api/workspace/issues/relationship",
            axum::routing::post(issues::relationship),
        )
        .route(
            "/api/workspace/issues/relationships",
            axum::routing::post(issues::relationships),
        )
        .route(
            "/api/workspace/issues/relationship-search",
            axum::routing::post(issues::search_relationships),
        )
        .route(
            "/api/workspace/issue-definitions",
            get(definitions::read).post(definitions::save),
        )
        .route(
            "/api/workspace/issues/classification",
            axum::routing::post(definitions::classify),
        )
        .route("/api/workspace/teams", get(teams::list).post(teams::create))
        .route("/api/workspace/team-directory", get(teams::directory))
        .route(
            "/api/workspace/teams/{slug}",
            get(teams::get).post(teams::update),
        )
        .route(
            "/api/workspace/teams/{slug}/archive",
            axum::routing::post(teams::archive),
        )
        .route(
            "/api/workspace/teams/{slug}/restore",
            axum::routing::post(teams::restore),
        )
        .route(
            "/api/workspace/teams/{slug}/join",
            axum::routing::post(teams::join),
        )
        .route(
            "/api/workspace/teams/{slug}/leave",
            axum::routing::post(teams::leave),
        )
        .route(
            "/api/workspace/teams/{slug}/members",
            get(teams::members).post(teams::add_members),
        )
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
    let api_routes = Router::new()
        .route(
            "/api/v1/teams",
            get(public_api::list).post(public_api::create),
        )
        .route(
            "/api/v1/teams/{id}",
            get(public_api::get)
                .patch(public_api::update)
                .delete(public_api::archive),
        )
        .route("/api/v1/openapi.json", get(public_api::spec))
        .route("/api/v1/docs", get(public_api::docs))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            public_api::guard,
        ));
    Router::new()
        .route(
            "/api/agent/runtime/model/{*path}",
            axum::routing::any(model_proxy::route),
        )
        .route(
            "/api/agent/runtime/openai/{*path}",
            axum::routing::any(model_proxy::route),
        )
        .route("/api/health/live", get(live))
        .route("/api/health/ready", get(ready))
        .route("/api/files/{*path}", axum::routing::any(files::handle))
        .route("/api/internal/sla-jobs", axum::routing::any(sla::scheduler))
        .route(
            "/api/internal/issue-retention",
            axum::routing::any(retention::route),
        )
        .merge(auth_routes)
        .merge(api_routes)
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
