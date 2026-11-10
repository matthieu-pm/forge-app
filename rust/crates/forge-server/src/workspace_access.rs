use crate::{
    auth::{AuthError, configuration, cookie_token, invalid_body, unavailable, valid_email},
    mail::InvitationMessage,
    state::AppState,
};
use async_trait::async_trait;
use axum::{
    Json,
    extract::{Query, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
};
use forge_core::security_commands::SecurityCommand;
use forge_store::{StoreError, api_keys, authority, joins, members, security};
use serde::Deserialize;
use serde_json::{Value, json};

struct SystemTxtResolver;
#[async_trait]
impl security::TxtResolver for SystemTxtResolver {
    async fn records(&self, domain: &str) -> Result<Vec<String>, StoreError> {
        let resolver = hickory_resolver::TokioAsyncResolver::tokio_from_system_conf()
            .map_err(|_| StoreError::DomainUnverified)?;
        let result = resolver
            .txt_lookup(domain)
            .await
            .map_err(|_| StoreError::DomainUnverified)?;
        Ok(result
            .iter()
            .filter_map(|record| {
                let bytes: Vec<u8> = record
                    .txt_data()
                    .iter()
                    .flat_map(|part| part.iter().copied())
                    .collect();
                String::from_utf8(bytes).ok()
            })
            .collect())
    }
}
fn body<T>(payload: Result<Json<T>, JsonRejection>) -> Result<T, AuthError> {
    payload.map(|Json(v)| v).map_err(|_| invalid_body())
}

pub(crate) async fn security_snapshot(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, AuthError> {
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    Ok(Json(
        security::snapshot(
            database,
            &actor,
            auth.base_url.as_str(),
            &auth.invite_secret,
        )
        .await?,
    ))
}
pub(crate) async fn security_command(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<SecurityCommand>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let command = body(payload)?;
    if command.expected_version() <= 0 {
        return Err(invalid_body());
    }
    if let SecurityCommand::AddDomain { domain, .. } = &command
        && (domain.trim().is_empty() || domain.trim().encode_utf16().count() > 253)
    {
        return Err(invalid_body());
    }
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    let resolver = state.dns.as_deref().unwrap_or(&SystemTxtResolver);
    match security::execute(
        database,
        &actor,
        &command,
        resolver,
        auth.base_url.as_str(),
        &auth.invite_secret,
    )
    .await
    {
        Ok(snapshot) => Ok(Json(json!({"ok":true,"snapshot":snapshot}))),
        Err(StoreError::PlanRequired(plan)) => Ok(Json(
            json!({"ok":false,"code":"PLAN_REQUIRED","requiredPlan":plan,"message":"Your workspace plan does not include this setting."}),
        )),
        Err(StoreError::InvalidInput) => Ok(Json(
            json!({"ok":false,"code":"VALIDATION_FAILED","message":"The security setting is invalid."}),
        )),
        Err(error) => {
            let error: AuthError = error.into();
            if error.0 == StatusCode::INTERNAL_SERVER_ERROR {
                return Err(error);
            }
            Ok(Json(json!({"ok":false,"code":error.1,"message":error.2})))
        }
    }
}
pub(crate) async fn access(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, AuthError> {
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    Ok(Json(members::summary(database, &actor).await?))
}
pub(crate) async fn list_keys(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, AuthError> {
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    Ok(Json(json!(api_keys::list(database, &actor).await?)))
}
pub(crate) async fn key_policy(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, AuthError> {
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    Ok(Json(api_keys::policy(database, &actor).await?))
}
pub(crate) async fn create_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<api_keys::CreateKey>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let input = body(payload)?;
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    Ok(Json(api_keys::create(database, &actor, &input).await?))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KeyId {
    key_id: String,
}
pub(crate) async fn revoke_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<KeyId>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let input = body(payload)?;
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    api_keys::revoke(database, &actor, &input.key_id).await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemberChange {
    member_id: String,
    role: Option<String>,
    #[serde(default)]
    leave: bool,
}
pub(crate) async fn change_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<MemberChange>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let input = body(payload)?;
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    let member = members::change(
        database,
        &actor,
        &input.member_id,
        input.role.as_deref(),
        input.leave,
    )
    .await?;
    Ok(Json(json!({"member":member})))
}
pub(crate) async fn invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<members::Invite>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let input = body(payload)?;
    if !valid_email(&input.email) {
        return Err(invalid_body());
    }
    let (database, auth) = configuration(&state)?;
    let token = cookie_token(&headers, auth)?;
    let actor = authority::session_actor(database, &token).await?;
    // Durable invitation workflow and retries are ported with background jobs.
    // Never acknowledge an invitation as queued when no Rust worker owns it.
    if std::env::var("FORGE_FEATURE_INVITATION_WORKFLOW").as_deref() == Ok("true")
        && std::env::var("FORGE_INVITATION_WORKFLOW_WORKSPACE_ALLOWLIST")
            .unwrap_or_default()
            .split(',')
            .any(|id| id.trim() == actor.workspace_id)
    {
        return Err(AuthError(
            StatusCode::SERVICE_UNAVAILABLE,
            "INVITATION_WORKFLOW_UNAVAILABLE",
            "The invitation workflow is not available in this Rust milestone.",
        ));
    }
    let mailer = state.mailer.as_ref().ok_or_else(unavailable)?;
    let workspace = forge_store::workspaces::list(database, &token)
        .await?
        .into_iter()
        .find(|w| w.id == actor.workspace_id)
        .ok_or(StoreError::Forbidden)?;
    let user = authority::session_identity(database, &token).await?;
    let invitation = members::invite(database, &actor, &input).await?;
    let mut url = auth
        .base_url
        .join("/accept-invitation")
        .map_err(|_| invalid_body())?;
    url.query_pairs_mut().append_pair("id", &invitation.id);
    let message = InvitationMessage {
        id: invitation.id.clone(),
        email: invitation.email.clone(),
        role: invitation.role.clone().unwrap_or_else(|| "member".into()),
        organization_name: workspace.name,
        inviter_name: if user.name.is_empty() {
            user.email.clone()
        } else {
            user.name
        },
        inviter_email: user.email,
        url: url.to_string(),
    };
    mailer.send_invitation(&message).await.map_err(|_| {
        AuthError(
            StatusCode::BAD_GATEWAY,
            "EMAIL_DELIVERY_FAILED",
            "The invitation was saved, but delivery failed. Retry sending it.",
        )
    })?;
    Ok(Json(
        json!({"ok":true,"invitation":{"id":invitation.id,"email":invitation.email,"role":invitation.role,"url":url},"delivery":"sent-synchronously"}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InvitationId {
    invitation_id: String,
}
pub(crate) async fn cancel_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<InvitationId>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let input = body(payload)?;
    let (database, auth) = configuration(&state)?;
    let actor = authority::session_actor(database, &cookie_token(&headers, auth)?).await?;
    Ok(Json(json!(
        members::cancel_invitation(database, &actor, &input.invitation_id).await?
    )))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct InviteToken {
    token: String,
}
pub(crate) async fn preview_invite(
    State(state): State<AppState>,
    Query(input): Query<InviteToken>,
) -> Result<Json<Value>, AuthError> {
    let (database, auth) = configuration(&state)?;
    Ok(Json(
        joins::preview(database, &input.token, &auth.invite_secret).await?,
    ))
}
pub(crate) async fn join_invite(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<InviteToken>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let input = body(payload)?;
    let (database, auth) = configuration(&state)?;
    Ok(Json(
        joins::join_invite(
            database,
            &cookie_token(&headers, auth)?,
            &input.token,
            &auth.invite_secret,
        )
        .await?,
    ))
}
pub(crate) async fn approved_domain(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, AuthError> {
    let (database, auth) = configuration(&state)?;
    Ok(Json(
        joins::approved_workspace(database, &cookie_token(&headers, auth)?).await?,
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceId {
    workspace_id: String,
}
pub(crate) async fn join_domain(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<WorkspaceId>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let input = body(payload)?;
    let (database, auth) = configuration(&state)?;
    Ok(Json(
        joins::join_domain(
            database,
            &cookie_token(&headers, auth)?,
            &input.workspace_id,
        )
        .await?,
    ))
}
