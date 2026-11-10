use crate::{
    auth::{AuthError, configuration, cookie_token, invalid_body, unavailable},
    state::{AppState, AuthSettings},
};
use axum::{
    Json,
    extract::{Query, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use serde_json::json;
use subtle::ConstantTimeEq;

#[derive(Default, Deserialize)]
pub(crate) struct DesktopQuery {
    client_id: Option<String>,
    state: Option<String>,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct TransferContext {
    client_id: String,
    state: String,
    code_challenge: String,
    code_challenge_method: String,
}

impl DesktopQuery {
    fn context(&self) -> Option<TransferContext> {
        let context = TransferContext {
            client_id: self.client_id.clone()?,
            state: self.state.clone()?,
            code_challenge: self.code_challenge.clone()?,
            code_challenge_method: self.code_challenge_method.clone()?,
        };
        context.valid().then_some(context)
    }
}
impl TransferContext {
    fn valid(&self) -> bool {
        self.client_id == "electron"
            && !self.state.is_empty()
            && self.state.len() <= 512
            && !self.code_challenge.is_empty()
            && self.code_challenge.len() <= 128
            && self.code_challenge_method.eq_ignore_ascii_case("s256")
    }
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn transfer_cookie_name(auth: &AuthSettings) -> &'static str {
    if auth.secure_cookies {
        "__Secure-better-auth.transfer_token"
    } else {
        "better-auth.transfer_token"
    }
}

pub(crate) fn save_context(
    auth: &AuthSettings,
    query: &DesktopQuery,
    response: &mut Response,
) -> Result<(), AuthError> {
    if let Some(context) = query.context() {
        let signed = forge_identity::sign_session_token(
            &serde_json::to_string(&context).map_err(|_| invalid_body())?,
            &auth.secret,
        )
        .map_err(|_| unavailable())?;
        response.headers_mut().append(
            header::SET_COOKIE,
            format!(
                "{}={signed}; Path=/; HttpOnly; SameSite=Lax; Max-Age=300{}",
                transfer_cookie_name(auth),
                if auth.secure_cookies { "; Secure" } else { "" }
            )
            .parse()
            .map_err(|_| unavailable())?,
        );
    }
    Ok(())
}

pub(crate) async fn apply_context(
    state: &AppState,
    headers: &HeaderMap,
    query: &DesktopQuery,
    session_token: &str,
    response: &mut Response,
) -> Result<Option<String>, AuthError> {
    let (database, auth) = configuration(state)?;
    let cookies = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .collect::<Vec<_>>()
        .join("; ");
    let saved = forge_identity::signed_cookie_from_header(
        &cookies,
        transfer_cookie_name(auth),
        &auth.secret,
    )
    .ok()
    .and_then(|value| serde_json::from_str::<TransferContext>(&value).ok())
    .filter(TransferContext::valid);
    let Some(context) = saved.or_else(|| query.context()) else {
        return Ok(None);
    };
    let code = random_token();
    forge_store::desktop_auth::issue(
        database,
        session_token,
        &code,
        &context.state,
        &context.code_challenge,
    )
    .await?;
    append_transfer_cookies(auth, &code, &context.state, response)?;
    Ok(Some(code))
}

fn append_transfer_cookies(
    auth: &AuthSettings,
    code: &str,
    state: &str,
    response: &mut Response,
) -> Result<(), AuthError> {
    let redirect = URL_SAFE_NO_PAD.encode(json!({"identifier":code,"state":state}).to_string());
    response.headers_mut().append(
        header::SET_COOKIE,
        format!(
            "better-auth.electron={redirect}; Path=/; SameSite=Lax; Max-Age=120{}",
            if auth.secure_cookies { "; Secure" } else { "" }
        )
        .parse()
        .map_err(|_| unavailable())?,
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        format!(
            "{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
            transfer_cookie_name(auth),
            if auth.secure_cookies { "; Secure" } else { "" }
        )
        .parse()
        .map_err(|_| unavailable())?,
    );
    Ok(())
}

#[derive(Deserialize)]
pub(crate) struct TransferBody {
    #[serde(rename = "callbackURL")]
    callback_url: Option<String>,
}

pub(crate) async fn transfer_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<DesktopQuery>,
    payload: Result<Json<TransferBody>, JsonRejection>,
) -> Result<Response, AuthError> {
    let Json(input) = payload.map_err(|_| invalid_body())?;
    let context = query.context().ok_or_else(invalid_body)?;
    let (database, auth) = configuration(&state)?;
    let token = cookie_token(&headers, auth)?;
    let callback = input
        .callback_url
        .as_ref()
        .map(|value| auth.callback(value))
        .transpose()
        .map_err(|_| invalid_body())?;
    let code = random_token();
    forge_store::desktop_auth::issue(
        database,
        &token,
        &code,
        &context.state,
        &context.code_challenge,
    )
    .await?;
    let mut response=Json(json!({"url":callback.as_ref().map(|url|url.as_str()),"redirect":callback.is_some(),"electron_authorization_code":code})).into_response();
    append_transfer_cookies(auth, &code, &context.state, &mut response)?;
    Ok(response)
}

#[derive(Deserialize)]
pub(crate) struct Redeem {
    token: String,
    state: String,
    code_verifier: String,
}

pub(crate) async fn redeem(
    State(state): State<AppState>,
    payload: Result<Json<Redeem>, JsonRejection>,
) -> Result<Response, AuthError> {
    let Json(input) = payload.map_err(|_| invalid_body())?;
    if input.token.is_empty()
        || input.state.is_empty()
        || input.code_verifier.is_empty()
        || input.code_verifier.len() > 256
    {
        return Err(invalid_body());
    }
    let (database, auth) = configuration(&state)?;
    let ticket = forge_store::desktop_auth::consume(database, &input.token).await?;
    let expected = URL_SAFE_NO_PAD
        .decode(ticket.code_challenge.trim_end_matches('='))
        .map_err(|_| invalid_body())?;
    let actual = URL_SAFE_NO_PAD
        .decode(forge_identity::pkce_challenge(&input.code_verifier))
        .map_err(|_| invalid_body())?;
    if ticket.state != input.state
        || ticket.code_challenge_method != "s256"
        || !bool::from(expected.as_slice().ct_eq(actual.as_slice()))
    {
        return Err(AuthError(
            StatusCode::BAD_REQUEST,
            "INVALID_CODE_VERIFIER",
            "The desktop authorization could not be verified.",
        ));
    }
    let token = random_token();
    forge_store::accounts::create_session(database, &ticket.user_id, &token, true, None).await?;
    let (_, user) = forge_store::accounts::session_and_user(database, &token, false, true)
        .await?
        .ok_or(forge_store::StoreError::Unauthenticated)?;
    let signed =
        forge_identity::sign_session_token(&token, &auth.secret).map_err(|_| unavailable())?;
    let mut response = Json(json!({"token":token,"user":user})).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        auth.cookie(&signed, true)
            .parse()
            .map_err(|_| unavailable())?,
    );
    Ok(response)
}

#[derive(Deserialize)]
pub(crate) struct InitProxy {
    provider: String,
    #[serde(flatten)]
    desktop: DesktopQuery,
}

pub(crate) async fn init_oauth_proxy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(mut query): Query<InitProxy>,
) -> Result<Response, AuthError> {
    query.desktop.client_id = Some("electron".into());
    query.desktop.context().ok_or_else(invalid_body)?;
    crate::oauth::init_desktop(state, headers, query.provider, query.desktop).await
}
