use crate::state::{AppState, AuthSettings};
use axum::{
    Json,
    body::Body,
    extract::{ConnectInfo, Query, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use forge_identity::{
    email_verification_token, hash_password, session_token_from_cookies, sign_session_token,
    verify_email_token, verify_password,
};
use forge_store::{StoreError, accounts};
use rand::{RngCore, rngs::OsRng};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};

pub(crate) struct AuthError(pub StatusCode, pub &'static str, pub &'static str);

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"code": self.1, "message": self.2}))).into_response()
    }
}

impl From<StoreError> for AuthError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::SlaReconciliationConflict => Self(
                StatusCode::CONFLICT,
                "SLA_RECONCILIATION_CONFLICT",
                "This interruption changed. Refresh the policy before classifying it.",
            ),
            StoreError::Unauthenticated => Self(
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "Authenticated session required.",
            ),
            StoreError::EmailNotVerified => Self(
                StatusCode::FORBIDDEN,
                "EMAIL_NOT_VERIFIED",
                "Verify your email address before using Forge.",
            ),
            StoreError::RateLimited => Self(
                StatusCode::TOO_MANY_REQUESTS,
                "RATE_LIMITED",
                "Too many requests. Try again later.",
            ),
            StoreError::Conflict => Self(
                StatusCode::CONFLICT,
                "CONFLICT",
                "The resource conflicts with existing state.",
            ),
            StoreError::NotFound => Self(
                StatusCode::NOT_FOUND,
                "NOT_FOUND",
                "The resource was not found.",
            ),
            StoreError::InvalidInput => invalid_body(),
            StoreError::PlanRequired(_) => Self(
                StatusCode::FORBIDDEN,
                "PLAN_REQUIRED",
                "Your workspace plan does not include this setting.",
            ),
            StoreError::DomainTaken => Self(
                StatusCode::CONFLICT,
                "DOMAIN_TAKEN",
                "This domain is already registered.",
            ),
            StoreError::DomainUnverified => Self(
                StatusCode::BAD_REQUEST,
                "VALIDATION_FAILED",
                "The verification TXT record is missing or expired.",
            ),
            StoreError::AccountNotLinked => Self(
                StatusCode::FORBIDDEN,
                "ACCOUNT_NOT_LINKED",
                "Sign in with your existing method before linking ChatGPT.",
            ),
            StoreError::Forbidden | StoreError::NoActiveWorkspace => Self(
                StatusCode::FORBIDDEN,
                "FORBIDDEN",
                "You do not have permission to perform this action.",
            ),
            StoreError::Database(sqlx::Error::Database(error))
                if error.constraint() == Some("workspace_free_member_limit") =>
            {
                Self(
                    StatusCode::CONFLICT,
                    "WORKSPACE_MEMBER_LIMIT",
                    "This Free workspace is full. Ask an owner to upgrade or remove a member.",
                )
            }
            StoreError::Database(sqlx::Error::Database(error))
                if error.code().as_deref() == Some("23505") =>
            {
                Self(
                    StatusCode::CONFLICT,
                    "CONFLICT",
                    "The resource conflicts with existing state.",
                )
            }
            _ => Self(
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_SERVER_ERROR",
                "The operation could not be completed.",
            ),
        }
    }
}

pub(crate) fn unavailable() -> AuthError {
    AuthError(
        StatusCode::SERVICE_UNAVAILABLE,
        "AUTH_UNAVAILABLE",
        "Authentication is not configured.",
    )
}
pub(crate) fn invalid_body() -> AuthError {
    AuthError(
        StatusCode::BAD_REQUEST,
        "INVALID_BODY",
        "The request body is invalid.",
    )
}

pub(crate) fn configuration(
    state: &AppState,
) -> Result<(&forge_store::Database, &AuthSettings), AuthError> {
    Ok((
        state.pool.as_ref().ok_or_else(unavailable)?,
        state.auth.as_deref().ok_or_else(unavailable)?,
    ))
}

pub(crate) fn cookie_token(headers: &HeaderMap, auth: &AuthSettings) -> Result<String, AuthError> {
    // Multiple Cookie header lines are legal; merge them without discarding duplicates.
    let cookie = headers
        .get_all(header::COOKIE)
        .iter()
        .map(|value| value.to_str())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| AuthError::from(StoreError::Unauthenticated))?
        .join("; ");
    session_token_from_cookies(&cookie, auth.secure_cookies, &auth.secret)
        .map_err(|_| AuthError::from(StoreError::Unauthenticated))
}

fn parsed<T>(payload: Result<Json<T>, JsonRejection>) -> Result<T, AuthError> {
    payload.map(|Json(value)| value).map_err(|_| invalid_body())
}

pub(crate) fn valid_email(email: &str) -> bool {
    // Same ASCII email grammar as the installed Zod validator.
    forge_identity::valid_email(email)
}

pub(crate) async fn guard(
    State(state): State<AppState>,
    request: axum::http::Request<Body>,
    next: Next,
) -> Response {
    let path = request.uri().path().to_owned();
    let client = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip().to_string())
        .unwrap_or_else(|| "local".into());
    let (window, maximum) = if path.ends_with("/send-verification-email") {
        (60, 3)
    } else if path.contains("/sign-in/") || path.contains("/sign-up/") {
        (10, 3)
    } else {
        (10, 100)
    };
    if !state
        .throttle
        .allow(format!("{client}:{path}"), window, maximum)
    {
        return AuthError(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Too many requests. Try again later.",
        )
        .into_response();
    }
    if request.method() != axum::http::Method::GET
        && request.method() != axum::http::Method::HEAD
        && let Some(auth) = &state.auth
    {
        let trusted = request
            .headers()
            .get(header::ORIGIN)
            .or_else(|| request.headers().get("electron-origin"))
            .and_then(|value| value.to_str().ok())
            .is_some_and(|origin| auth.trusted_origin(origin));
        if !trusted {
            return AuthError(
                StatusCode::FORBIDDEN,
                "INVALID_ORIGIN",
                "The request origin is not trusted.",
            )
            .into_response();
        }
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        axum::http::HeaderValue::from_static("nosniff"),
    );
    response
        .headers_mut()
        .insert(header::VARY, axum::http::HeaderValue::from_static("Cookie"));
    response
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Signup {
    name: String,
    email: String,
    password: String,
    image: Option<String>,
    #[serde(rename = "callbackURL")]
    callback_url: Option<String>,
}

pub(crate) async fn signup(
    State(state): State<AppState>,
    Query(desktop): Query<crate::desktop_auth::DesktopQuery>,
    payload: Result<Json<Signup>, JsonRejection>,
) -> Result<Response, AuthError> {
    let input = parsed(payload)?;
    let (pool, auth) = configuration(&state)?;
    let mailer = state.mailer.as_ref().ok_or(AuthError(
        StatusCode::SERVICE_UNAVAILABLE,
        "EMAIL_DELIVERY_FAILED",
        "Email delivery is not configured.",
    ))?;
    if input.name.is_empty() || !valid_email(&input.email) {
        return Err(invalid_body());
    }
    let length = input.password.encode_utf16().count();
    if length < 8 {
        return Err(AuthError(
            StatusCode::BAD_REQUEST,
            "PASSWORD_TOO_SHORT",
            "Password is too short.",
        ));
    }
    if length > 128 {
        return Err(AuthError(
            StatusCode::BAD_REQUEST,
            "PASSWORD_TOO_LONG",
            "Password is too long.",
        ));
    }
    let callback = auth
        .callback(input.callback_url.as_deref().unwrap_or("/"))
        .map_err(|_| invalid_body())?;
    let hash = tokio::task::spawn_blocking(move || hash_password(&input.password))
        .await
        .map_err(|_| unavailable())?
        .map_err(|_| unavailable())?;
    let registration = accounts::register_email_user(
        pool,
        &input.name,
        &input.email.to_lowercase(),
        input.image.as_deref(),
        &hash,
    )
    .await?;
    if registration.created {
        let url = verification_url(auth, &registration.user.email, callback.as_str())?;
        mailer
            .send(&registration.user, url.as_str())
            .await
            .map_err(|_| {
                AuthError(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "EMAIL_DELIVERY_FAILED",
                    "Email delivery failed.",
                )
            })?;
    }
    let mut response = Json(json!({"token": null,"user": registration.user})).into_response();
    crate::desktop_auth::save_context(auth, &desktop, &mut response)?;
    Ok(response)
}

fn verification_url(
    auth: &AuthSettings,
    email: &str,
    callback: &str,
) -> Result<url::Url, AuthError> {
    let token = email_verification_token(email, &auth.secret, Utc::now().timestamp())
        .map_err(|_| unavailable())?;
    let mut url = auth
        .base_url
        .join("/api/auth/verify-email")
        .map_err(|_| unavailable())?;
    url.query_pairs_mut()
        .append_pair("token", &token)
        .append_pair("callbackURL", callback);
    Ok(url)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Signin {
    email: String,
    password: String,
    remember_me: Option<bool>,
    #[serde(rename = "callbackURL")]
    callback_url: Option<String>,
}

pub(crate) async fn signin(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(desktop): Query<crate::desktop_auth::DesktopQuery>,
    payload: Result<Json<Signin>, JsonRejection>,
) -> Result<Response, AuthError> {
    let input = parsed(payload)?;
    let (pool, auth) = configuration(&state)?;
    if !valid_email(&input.email) || input.password.encode_utf16().count() > 128 {
        return Err(invalid_body());
    }
    let callback = input
        .callback_url
        .as_ref()
        .map(|callback| auth.callback(callback))
        .transpose()
        .map_err(|_| invalid_body())?;
    let account = accounts::credential_account(pool, &input.email.to_lowercase()).await?;
    let hash = account.as_ref().map(|(_, hash)| hash.clone());
    let valid = tokio::task::spawn_blocking(move || match hash {
        Some(hash) => verify_password(&input.password, &hash),
        None => {
            let _ = hash_password(&input.password);
            false
        }
    })
    .await
    .map_err(|_| unavailable())?;
    if !valid {
        return Err(AuthError(
            StatusCode::UNAUTHORIZED,
            "INVALID_EMAIL_OR_PASSWORD",
            "Invalid email or password.",
        ));
    }
    let (user, _) = account.ok_or(AuthError(
        StatusCode::UNAUTHORIZED,
        "INVALID_EMAIL_OR_PASSWORD",
        "Invalid email or password.",
    ))?;
    if !user.email_verified {
        return Err(StoreError::EmailNotVerified.into());
    }
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let remember = input.remember_me.unwrap_or(true);
    let _session = accounts::create_session(
        pool,
        &user.id,
        &token,
        remember,
        headers
            .get(header::USER_AGENT)
            .and_then(|value| value.to_str().ok()),
    )
    .await?;
    let signed = sign_session_token(&token, &auth.secret).map_err(|_| unavailable())?;
    let mut body = json!({"redirect": callback.is_some(), "token": token, "url": callback.as_ref().map(|url| url.as_str()), "user":user});
    let mut context_response = Response::new(Body::empty());
    if let Some(code) = crate::desktop_auth::apply_context(
        &state,
        &headers,
        &desktop,
        &token,
        &mut context_response,
    )
    .await?
    {
        body["electron_authorization_code"] = Value::String(code);
    }
    let mut response = Json(body).into_response();
    response
        .headers_mut()
        .extend(context_response.into_parts().0.headers);
    response.headers_mut().append(
        header::SET_COOKIE,
        auth.cookie(&signed, remember)
            .parse()
            .map_err(|_| unavailable())?,
    );
    if !remember {
        let signed = sign_session_token("true", &auth.secret).map_err(|_| unavailable())?;
        let name = if auth.secure_cookies {
            "__Secure-better-auth.dont_remember"
        } else {
            "better-auth.dont_remember"
        };
        response.headers_mut().append(
            header::SET_COOKIE,
            format!(
                "{name}={signed}; Path=/; HttpOnly; SameSite=Lax{}",
                if auth.secure_cookies { "; Secure" } else { "" }
            )
            .parse()
            .map_err(|_| unavailable())?,
        );
    }
    if let Some(callback) = callback {
        response.headers_mut().insert(
            header::LOCATION,
            callback.as_str().parse().map_err(|_| invalid_body())?,
        );
    }
    Ok(response)
}

pub(crate) async fn get_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, AuthError> {
    session_response(&state, &headers, false)
        .await
        .map(|(value, _)| Json(value))
}

pub(crate) async fn refresh_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, AuthError> {
    let (value, cookie) = session_response(&state, &headers, true).await?;
    let mut response = Json(value).into_response();
    if let Some(cookie) = cookie {
        response.headers_mut().append(
            header::SET_COOKIE,
            cookie.parse().map_err(|_| unavailable())?,
        );
    }
    Ok(response)
}

async fn session_response(
    state: &AppState,
    headers: &HeaderMap,
    refresh: bool,
) -> Result<(Value, Option<String>), AuthError> {
    let (pool, auth) = configuration(state)?;
    let Ok(token) = cookie_token(headers, auth) else {
        return Ok((Value::Null, None));
    };
    let remember = !headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|cookie| {
            cookie
                .split(';')
                .filter_map(|part| part.trim().split_once('='))
                .any(|(name, signed)| {
                    name.ends_with("better-auth.dont_remember")
                        && forge_identity::verify_session_token(signed, &auth.secret)
                            .ok()
                            .as_deref()
                            == Some("true")
                })
        });
    let Some((session, user)) = accounts::session_and_user(pool, &token, refresh, remember).await?
    else {
        return Ok((Value::Null, None));
    };
    if refresh || !remember {
        let cookie = if refresh && remember {
            Some(auth.cookie(
                &sign_session_token(&token, &auth.secret).map_err(|_| unavailable())?,
                true,
            ))
        } else {
            None
        };
        Ok((json!({"session":session,"user":user}), cookie))
    } else {
        let needs_refresh = accounts::needs_refresh(&session);
        Ok((
            json!({"session":session,"user":user,"needsRefresh":needs_refresh}),
            None,
        ))
    }
}

pub(crate) async fn signout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, AuthError> {
    let (pool, auth) = configuration(&state)?;
    if let Ok(token) = cookie_token(&headers, auth) {
        accounts::sign_out(pool, &token).await?;
    }
    let mut response = Json(json!({"success":true})).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        auth.expired_cookie().parse().map_err(|_| unavailable())?,
    );
    for name in [
        "better-auth.dont_remember",
        "better-auth.session_data",
        "__Secure-better-auth.dont_remember",
        "__Secure-better-auth.session_data",
    ] {
        response.headers_mut().append(
            header::SET_COOKIE,
            format!(
                "{name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
                if name.starts_with("__Secure-") {
                    "; Secure"
                } else {
                    ""
                }
            )
            .parse()
            .map_err(|_| unavailable())?,
        );
    }
    Ok(response)
}

#[derive(Deserialize)]
pub(crate) struct VerifyQuery {
    token: String,
    #[serde(rename = "callbackURL")]
    callback_url: Option<String>,
}

pub(crate) async fn verify_email(
    State(state): State<AppState>,
    Query(query): Query<VerifyQuery>,
) -> Result<Response, AuthError> {
    let (pool, auth) = configuration(&state)?;
    let callback = query
        .callback_url
        .as_ref()
        .map(|callback| auth.callback(callback))
        .transpose()
        .map_err(|_| invalid_body())?;
    let claims =
        verify_email_token(&query.token, &auth.secret, Utc::now().timestamp()).map_err(|_| {
            AuthError(
                StatusCode::BAD_REQUEST,
                "INVALID_TOKEN",
                "The verification link is invalid or expired.",
            )
        })?;
    // Change-email tokens need their own authenticated two-step lifecycle.
    if claims.update_to.is_some() || claims.request_type.is_some() {
        return Err(AuthError(
            StatusCode::SERVICE_UNAVAILABLE,
            "CHANGE_EMAIL_UNAVAILABLE",
            "Email changes are not available yet.",
        ));
    }
    if !accounts::verify_email(pool, &claims.email).await? {
        return Err(AuthError(
            StatusCode::BAD_REQUEST,
            "USER_NOT_FOUND",
            "The verification link is invalid or expired.",
        ));
    }
    if let Some(callback) = callback {
        return Ok((StatusCode::FOUND, [(header::LOCATION, callback.as_str())]).into_response());
    }
    Ok(Json(json!({"status":true,"user":null})).into_response())
}

#[derive(Deserialize)]
pub(crate) struct SendVerification {
    email: String,
    #[serde(rename = "callbackURL")]
    callback_url: Option<String>,
}

pub(crate) async fn send_verification(
    State(state): State<AppState>,
    payload: Result<Json<SendVerification>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let started = Instant::now();
    let input = parsed(payload)?;
    let (pool, auth) = configuration(&state)?;
    let mailer = state.mailer.as_ref().ok_or(AuthError(
        StatusCode::SERVICE_UNAVAILABLE,
        "EMAIL_DELIVERY_FAILED",
        "Email delivery is not configured.",
    ))?;
    if !valid_email(&input.email) {
        return Err(invalid_body());
    }
    let callback = auth
        .callback(input.callback_url.as_deref().unwrap_or("/"))
        .map_err(|_| invalid_body())?;
    let email = input.email.to_lowercase();
    let user = accounts::user_by_email(pool, &email).await?;
    let url = verification_url(auth, &email, callback.as_str())?;
    let result = match user {
        Some(user) if !user.email_verified => mailer.send(&user, url.as_str()).await,
        _ => Ok(()),
    };
    if let Some(delay) = Duration::from_millis(500).checked_sub(started.elapsed()) {
        tokio::time::sleep(delay).await;
    }
    result.map_err(|_| {
        AuthError(
            StatusCode::SERVICE_UNAVAILABLE,
            "EMAIL_DELIVERY_FAILED",
            "Email delivery failed.",
        )
    })?;
    Ok(Json(json!({"status":true})))
}

pub(crate) async fn list_sessions(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, AuthError> {
    let (pool, auth) = configuration(&state)?;
    let token = cookie_token(&headers, auth)?;
    Ok(Json(
        serde_json::to_value(accounts::list_sessions(pool, &token).await?)
            .map_err(|_| unavailable())?,
    ))
}

#[derive(Deserialize)]
pub(crate) struct RevokeSession {
    token: String,
}

pub(crate) async fn revoke_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<RevokeSession>, JsonRejection>,
) -> Result<Json<Value>, AuthError> {
    let input = parsed(payload)?;
    let (pool, auth) = configuration(&state)?;
    let token = cookie_token(&headers, auth)?;
    accounts::revoke_session(pool, &token, &input.token).await?;
    Ok(Json(json!({"status":true})))
}

pub(crate) async fn update_user_denied() -> Response {
    AuthError(
        StatusCode::FORBIDDEN,
        "FORBIDDEN",
        "Use the authenticated profile command to edit your profile.",
    )
    .into_response()
}
