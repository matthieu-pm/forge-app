use crate::{
    auth::{AuthError, configuration, cookie_token, invalid_body, unavailable, valid_email},
    state::{AppState, AuthSettings},
};
use axum::{
    Json,
    extract::{Query, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use forge_store::oauth::{self, LinkTarget, OAuthTicket};
use rand::{RngCore, rngs::OsRng};
use serde::Deserialize;
use serde_json::json;

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn state_cookie_name(auth: &AuthSettings) -> &'static str {
    if auth.secure_cookies {
        "__Secure-better-auth.state"
    } else {
        "better-auth.state"
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Start {
    provider: String,
    #[serde(rename = "callbackURL")]
    callback_url: Option<String>,
    #[serde(rename = "errorCallbackURL")]
    error_url: Option<String>,
    #[serde(rename = "newUserCallbackURL")]
    new_user_url: Option<String>,
    disable_redirect: Option<bool>,
}

pub(crate) async fn sign_in(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(desktop): Query<crate::desktop_auth::DesktopQuery>,
    payload: Result<Json<Start>, JsonRejection>,
) -> Result<Response, AuthError> {
    start(state, headers, payload, false, desktop).await
}
pub(crate) async fn link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(desktop): Query<crate::desktop_auth::DesktopQuery>,
    payload: Result<Json<Start>, JsonRejection>,
) -> Result<Response, AuthError> {
    start(state, headers, payload, true, desktop).await
}

async fn start(
    state: AppState,
    headers: HeaderMap,
    payload: Result<Json<Start>, JsonRejection>,
    link: bool,
    desktop: crate::desktop_auth::DesktopQuery,
) -> Result<Response, AuthError> {
    let Json(input) = payload.map_err(|_| invalid_body())?;
    let is_link = link;
    if input.provider != "chatgpt" {
        return Err(AuthError(
            StatusCode::BAD_REQUEST,
            "PROVIDER_NOT_FOUND",
            "The sign-in provider is unavailable.",
        ));
    }
    let (database, auth) = configuration(&state)?;
    let client = state.oauth.as_ref().ok_or(AuthError(
        StatusCode::SERVICE_UNAVAILABLE,
        "PROVIDER_NOT_FOUND",
        "ChatGPT sign-in is not configured.",
    ))?;
    let callback = auth
        .callback(input.callback_url.as_deref().unwrap_or("/"))
        .map_err(|_| invalid_body())?;
    let error_url = input
        .error_url
        .as_ref()
        .map(|url| auth.callback(url))
        .transpose()
        .map_err(|_| invalid_body())?;
    let new_user_url = input
        .new_user_url
        .as_ref()
        .map(|url| auth.callback(url))
        .transpose()
        .map_err(|_| invalid_body())?;
    let link = if link {
        let token = cookie_token(&headers, auth)?;
        let (session, user) =
            forge_store::accounts::session_and_user(database, &token, false, true)
                .await?
                .ok_or(forge_store::StoreError::Unauthenticated)?;
        if !user.email_verified {
            return Err(forge_store::StoreError::EmailNotVerified.into());
        }
        Some(LinkTarget {
            user_id: user.id,
            email: user.email,
            session_id: Some(session.id),
        })
    } else {
        None
    };
    let state_id = random_token();
    let verifier = random_token();
    let redirect = auth
        .base_url
        .join("/api/auth/callback/chatgpt")
        .map_err(|_| unavailable())?;
    let authorization = client
        .authorization_url(&state_id, &verifier, redirect.as_str())
        .await
        .map_err(|_| {
            AuthError(
                StatusCode::SERVICE_UNAVAILABLE,
                "PROVIDER_UNAVAILABLE",
                "ChatGPT sign-in is unavailable. Try again.",
            )
        })?;
    oauth::save_ticket(
        database,
        &state_id,
        &OAuthTicket {
            callback_url: callback.into(),
            code_verifier: verifier,
            error_url: error_url.map(Into::into),
            new_user_url: new_user_url.map(Into::into),
            expires_at: Utc::now().timestamp_millis() + 600_000,
            oauth_state: Some(state_id.clone()),
            link,
        },
    )
    .await?;
    let signed =
        forge_identity::sign_session_token(&state_id, &auth.secret).map_err(|_| unavailable())?;
    let mut response = Json(
        json!({"url":authorization.as_str(),"redirect":!input.disable_redirect.unwrap_or(false)}),
    )
    .into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        format!(
            "{}={signed}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300{}",
            state_cookie_name(auth),
            if auth.secure_cookies { "; Secure" } else { "" }
        )
        .parse()
        .map_err(|_| unavailable())?,
    );
    if !input.disable_redirect.unwrap_or(false) {
        response.headers_mut().insert(
            header::LOCATION,
            authorization.as_str().parse().map_err(|_| unavailable())?,
        );
    }
    if !is_link {
        crate::desktop_auth::save_context(auth, &desktop, &mut response)?;
    }
    Ok(response)
}

#[derive(Deserialize)]
pub(crate) struct Callback {
    state: String,
    code: Option<String>,
    error: Option<String>,
}

fn redirect_response(
    auth: &AuthSettings,
    url: &str,
    error: Option<&str>,
) -> Result<Response, AuthError> {
    let mut target = auth.callback(url).map_err(|_| invalid_body())?;
    if let Some(error) = error {
        target.query_pairs_mut().append_pair("error", error);
    }
    let mut response = (StatusCode::FOUND, [(header::LOCATION, target.as_str())]).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        format!(
            "{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
            state_cookie_name(auth),
            if auth.secure_cookies { "; Secure" } else { "" }
        )
        .parse()
        .map_err(|_| unavailable())?,
    );
    Ok(response)
}

pub(crate) async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<Callback>,
) -> Result<Response, AuthError> {
    let (database, auth) = configuration(&state)?;
    let client = state.oauth.as_ref().ok_or(unavailable())?;
    let cookies = headers
        .get_all(header::COOKIE)
        .iter()
        .map(|value| value.to_str())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| invalid_body())?
        .join("; ");
    let browser_state =
        forge_identity::signed_cookie_from_header(&cookies, state_cookie_name(auth), &auth.secret)
            .map_err(|_| {
                AuthError(
                    StatusCode::FORBIDDEN,
                    "STATE_MISMATCH",
                    "The sign-in transaction could not be verified.",
                )
            })?;
    if browser_state != query.state {
        return Err(AuthError(
            StatusCode::FORBIDDEN,
            "STATE_MISMATCH",
            "The sign-in transaction could not be verified.",
        ));
    }
    let ticket = oauth::consume_ticket(database, &query.state).await?;
    let error_url = ticket.error_url.as_deref().unwrap_or("/login");
    if query.error.is_some() || query.code.as_ref().is_none_or(String::is_empty) {
        return redirect_response(auth, error_url, Some("oauth_authorization_failed"));
    }
    let redirect = auth
        .base_url
        .join("/api/auth/callback/chatgpt")
        .map_err(|_| unavailable())?;
    let identity = match client
        .finish(
            query.code.as_deref().unwrap_or(""),
            &ticket.code_verifier,
            redirect.as_str(),
        )
        .await
    {
        Ok(identity) if identity.email.as_deref().is_some_and(valid_email) => identity,
        _ => return redirect_response(auth, error_url, Some("oauth_identity_invalid")),
    };
    let account_id = format!(
        "https://auth.openai.com|{}|{}",
        client.client_id(),
        identity.subject
    );
    let current = cookie_token(&headers, auth).ok();
    let token = random_token();
    let login = match oauth::finish_social_login(
        database,
        &account_id,
        &identity,
        &token,
        ticket.link.as_ref(),
        current.as_deref(),
    )
    .await
    {
        Ok(login) => login,
        Err(forge_store::StoreError::AccountNotLinked) => {
            return redirect_response(auth, error_url, Some("account_not_linked"));
        }
        Err(error) => return Err(error.into()),
    };
    if !login.user.email_verified {
        return redirect_response(auth, error_url, Some("email_not_verified"));
    }
    let target = if login.new_user {
        ticket
            .new_user_url
            .as_deref()
            .unwrap_or(&ticket.callback_url)
    } else {
        &ticket.callback_url
    };
    let mut response = redirect_response(auth, target, None)?;
    if login.session.is_some() {
        let signed =
            forge_identity::sign_session_token(&token, &auth.secret).map_err(|_| unavailable())?;
        response.headers_mut().append(
            header::SET_COOKIE,
            auth.cookie(&signed, true)
                .parse()
                .map_err(|_| unavailable())?,
        );
        crate::desktop_auth::apply_context(
            &state,
            &headers,
            &Default::default(),
            &token,
            &mut response,
        )
        .await?;
    }
    Ok(response)
}

pub(crate) async fn init_desktop(
    state: AppState,
    headers: HeaderMap,
    provider: String,
    desktop: crate::desktop_auth::DesktopQuery,
) -> Result<Response, AuthError> {
    let input = Start {
        provider,
        callback_url: None,
        error_url: None,
        new_user_url: None,
        disable_redirect: Some(false),
    };
    let response = start(state, headers, Ok(Json(input)), false, desktop).await?;
    let (mut parts, _) = response.into_parts();
    parts.status = StatusCode::FOUND;
    Ok(Response::from_parts(parts, axum::body::Body::empty()))
}
