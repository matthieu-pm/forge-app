use async_trait::async_trait;
use axum::{
    Router,
    body::Body,
    http::{HeaderMap, Request, StatusCode, header},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use forge_server::{
    oauth_provider::{ChatGptClient, OidcTransport, ProviderError},
    state::{AppState, AuthSettings},
};
use forge_store::{
    Database,
    accounts::{self, User},
};
use http_body_util::BodyExt;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use rsa::{RsaPrivateKey, pkcs1::EncodeRsaPrivateKey, traits::PublicKeyParts};
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::sync::{Arc, OnceLock};
use tower::ServiceExt;
use url::Url;
use uuid::Uuid;

const SECRET: &str = "local-oauth-fixture-secret-at-least-32-bytes";
const ORIGIN: &str = "http://localhost:3100";

struct Signer {
    key: EncodingKey,
    jwks: Value,
}
fn signer() -> &'static Signer {
    static SIGNER: OnceLock<Signer> = OnceLock::new();
    SIGNER.get_or_init(|| {
        let private=RsaPrivateKey::new(&mut rand::rngs::OsRng,2048).unwrap();
        let jwks=json!({"keys":[{"kty":"RSA","kid":"ephemeral-test-key","alg":"RS256","use":"sig","n":URL_SAFE_NO_PAD.encode(private.n().to_bytes_be()),"e":URL_SAFE_NO_PAD.encode(private.e().to_bytes_be())}]});
        let der=private.to_pkcs1_der().unwrap();Signer {key:EncodingKey::from_rsa_der(der.as_bytes()),jwks}
    })
}

struct Provider {
    email: String,
    subject: String,
    bad_nonce: bool,
}

#[async_trait]
impl OidcTransport for Provider {
    async fn get_json(&self, url: &Url) -> Result<Value, ProviderError> {
        if url.path().ends_with("openid-configuration") {
            Ok(
                json!({"issuer":"https://auth.openai.com","authorization_endpoint":"https://auth.openai.com/authorize","token_endpoint":"https://auth.openai.com/token","jwks_uri":"https://auth.openai.com/jwks"}),
            )
        } else if url.path() == "/jwks" {
            Ok(signer().jwks.clone())
        } else {
            Err(ProviderError)
        }
    }
    async fn exchange(
        &self,
        url: &Url,
        form: &[(String, String)],
        basic: Option<(&str, &str)>,
    ) -> Result<Value, ProviderError> {
        assert_eq!(url.as_str(), "https://auth.openai.com/token");
        assert!(basic.is_none());
        let value = |key: &str| {
            form.iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.as_str())
                .unwrap()
        };
        assert_eq!(value("grant_type"), "authorization_code");
        assert_eq!(value("client_id"), "oaiapp_forge");
        let nonce = if self.bad_nonce {
            "wrong-transaction".into()
        } else {
            forge_identity::website_nonce(value("code_verifier"))
        };
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("ephemeral-test-key".into());
        let token=encode(&header,&json!({"sub":self.subject,"iss":"https://auth.openai.com","aud":"oaiapp_forge","iat":chrono::Utc::now().timestamp(),"exp":chrono::Utc::now().timestamp()+300,"nonce":nonce,"email":self.email,"email_verified":true,"name":"OIDC account"}),&signer().key).unwrap();
        Ok(
            json!({"id_token":token,"access_token":"ephemeral-fixture-access-token","refresh_token":"ephemeral-fixture-refresh-token"}),
        )
    }
}

struct Fixture {
    pool: PgPool,
    database: Database,
    app: Router,
    email: String,
}

impl Fixture {
    async fn new(bad_nonce: bool) -> Self {
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
        let email = format!("{}@example.test", Uuid::new_v4());
        let provider = Provider {
            email: email.clone(),
            subject: Uuid::new_v4().to_string(),
            bad_nonce,
        };
        let state = AppState::configured(
            pool.clone(),
            AuthSettings::new(SECRET.into(), ORIGIN).unwrap(),
            None,
        )
        .with_chatgpt(ChatGptClient::new("oaiapp_forge".into(), None, Arc::new(provider)).unwrap());
        Self {
            database: Database::new(pool.clone()),
            pool,
            app: forge_server::router_with_state(state),
            email,
        }
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        cookie: Option<&str>,
        data: Option<Value>,
    ) -> (StatusCode, HeaderMap, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::ORIGIN, ORIGIN);
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        let body = match data {
            Some(value) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(value.to_string())
            }
            None => Body::empty(),
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
        (
            status,
            headers,
            if bytes.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&bytes).unwrap()
            },
        )
    }
    async fn start(&self, link: bool, cookie: Option<&str>) -> (String, String) {
        let (status,headers,result)=self.request("POST",if link {"/api/auth/link-social"}else{"/api/auth/sign-in/social"},cookie,Some(json!({"provider":"chatgpt","callbackURL":"/success","errorCallbackURL":"/login"}))).await;
        assert_eq!(status, StatusCode::OK, "{result}");
        let authorization = Url::parse(result["url"].as_str().unwrap()).unwrap();
        let state = authorization
            .query_pairs()
            .find(|(key, _)| key == "state")
            .unwrap()
            .1
            .into_owned();
        let state_cookie = headers
            .get_all(header::SET_COOKIE)
            .iter()
            .find_map(|value| {
                let text = value.to_str().ok()?;
                text.starts_with("better-auth.state=")
                    .then(|| text.split(';').next().unwrap().to_owned())
            })
            .unwrap();
        (
            format!("/api/auth/callback/chatgpt?state={state}&code=authorization-code"),
            state_cookie,
        )
    }
    async fn existing_account(&self) -> (User, String, String) {
        let user = accounts::register_email_user(
            &self.database,
            "Existing account",
            &self.email,
            None,
            "fixture-no-password-login",
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
async fn oidc_callback_creates_a_session_once_without_persisting_openai_tokens() {
    let fixture = Fixture::new(false).await;
    let (callback, cookie) = fixture.start(false, None).await;
    let (status, headers, result) = fixture.request("GET", &callback, Some(&cookie), None).await;
    assert_eq!(status, StatusCode::FOUND, "{result}");
    assert_eq!(headers[header::LOCATION], "http://localhost:3100/success");
    let session_cookie = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .find_map(|value| {
            let text = value.to_str().ok()?;
            text.starts_with("better-auth.session_token=")
                .then(|| text.split(';').next().unwrap().to_owned())
        })
        .unwrap();
    let (_, _, session) = fixture
        .request("GET", "/api/auth/get-session", Some(&session_cookie), None)
        .await;
    assert_eq!(session["user"]["email"], fixture.email);
    assert_eq!(session["user"]["emailVerified"], true);
    let credentials:Vec<(Option<String>,Option<String>,Option<String>)>=sqlx::query_as("SELECT access_token,refresh_token,id_token FROM account WHERE user_id=$1 AND provider_id='chatgpt'").bind(session["user"]["id"].as_str().unwrap()).fetch_all(&fixture.pool).await.unwrap();
    assert_eq!(credentials, vec![(None, None, None)]);
    assert_ne!(
        fixture
            .request("GET", &callback, Some(&cookie), None)
            .await
            .0,
        StatusCode::FOUND
    );
}

#[tokio::test]
async fn matching_email_never_implicitly_links_an_existing_account() {
    let fixture = Fixture::new(false).await;
    let (user, _, _) = fixture.existing_account().await;
    let (callback, cookie) = fixture.start(false, None).await;
    let (status, headers, _) = fixture.request("GET", &callback, Some(&cookie), None).await;
    assert_eq!(status, StatusCode::FOUND);
    assert!(
        headers[header::LOCATION]
            .to_str()
            .unwrap()
            .contains("error=account_not_linked")
    );
    let linked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM account WHERE user_id=$1 AND provider_id='chatgpt'",
    )
    .bind(user.id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(linked, 0);
}

#[tokio::test]
async fn an_explicit_authenticated_link_allows_later_provider_login() {
    let fixture = Fixture::new(false).await;
    let (user, _, session_cookie) = fixture.existing_account().await;
    let (callback, state_cookie) = fixture.start(true, Some(&session_cookie)).await;
    let cookies = format!("{session_cookie}; {state_cookie}");
    let (status, headers, _) = fixture
        .request("GET", &callback, Some(&cookies), None)
        .await;
    assert_eq!(status, StatusCode::FOUND);
    assert_eq!(headers[header::LOCATION], "http://localhost:3100/success");
    let linked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM account WHERE user_id=$1 AND provider_id='chatgpt'",
    )
    .bind(&user.id)
    .fetch_one(&fixture.pool)
    .await
    .unwrap();
    assert_eq!(linked, 1);
    let (callback, state_cookie) = fixture.start(false, None).await;
    let (status, headers, _) = fixture
        .request("GET", &callback, Some(&state_cookie), None)
        .await;
    assert_eq!(status, StatusCode::FOUND);
    assert_eq!(headers[header::LOCATION], "http://localhost:3100/success");
}

#[tokio::test]
async fn browser_binding_and_oidc_nonce_both_protect_the_callback() {
    let fixture = Fixture::new(true).await;
    let (callback, state_cookie) = fixture.start(false, None).await;
    assert_eq!(
        fixture.request("GET", &callback, None, None).await.0,
        StatusCode::FORBIDDEN
    );
    let (status, headers, _) = fixture
        .request("GET", &callback, Some(&state_cookie), None)
        .await;
    assert_eq!(status, StatusCode::FOUND);
    assert!(
        headers[header::LOCATION]
            .to_str()
            .unwrap()
            .contains("error=oauth_identity_invalid")
    );
    assert!(
        accounts::user_by_email(&fixture.database, &fixture.email)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn desktop_handoff_requires_the_verifier_and_is_single_use() {
    let fixture = Fixture::new(false).await;
    let (user, _, cookie) = fixture.existing_account().await;
    let verifier = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    let challenge = forge_identity::pkce_challenge(verifier);
    let path = format!(
        "/api/auth/electron/transfer-user?client_id=electron&state=native-state&code_challenge={challenge}&code_challenge_method=S256"
    );
    let (status, _, transfer) = fixture
        .request("POST", &path, Some(&cookie), Some(json!({})))
        .await;
    assert_eq!(status, StatusCode::OK);
    let code = transfer["electron_authorization_code"].as_str().unwrap();
    let body = json!({"token":code,"state":"native-state","code_verifier":verifier});
    let (status, headers, session) = fixture
        .request("POST", "/api/auth/electron/token", None, Some(body.clone()))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(session["user"]["id"], user.id);
    assert!(headers.contains_key(header::SET_COOKIE));
    assert_ne!(
        fixture
            .request("POST", "/api/auth/electron/token", None, Some(body))
            .await
            .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn a_wrong_desktop_verifier_cannot_create_a_session() {
    let fixture = Fixture::new(false).await;
    let (user, _, cookie) = fixture.existing_account().await;
    let challenge = forge_identity::pkce_challenge(&"a".repeat(43));
    let path = format!(
        "/api/auth/electron/transfer-user?client_id=electron&state=native-state&code_challenge={challenge}&code_challenge_method=S256"
    );
    let (_, _, transfer) = fixture
        .request("POST", &path, Some(&cookie), Some(json!({})))
        .await;
    assert_eq!(fixture.request("POST","/api/auth/electron/token",None,Some(json!({"token":transfer["electron_authorization_code"],"state":"native-state","code_verifier":"wrong"}))).await.0,StatusCode::BAD_REQUEST);
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM session WHERE user_id=$1")
        .bind(user.id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
    assert_eq!(sessions, 1);
}

#[tokio::test]
async fn desktop_oauth_keeps_the_browser_and_native_pkce_transactions_separate() {
    let fixture = Fixture::new(false).await;
    let verifier = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefg";
    let challenge = forge_identity::pkce_challenge(verifier);
    let path = format!(
        "/api/auth/sign-in/social?client_id=electron&state=native-state&code_challenge={challenge}&code_challenge_method=S256"
    );
    let (status, headers, result) = fixture
        .request(
            "POST",
            &path,
            None,
            Some(json!({"provider":"chatgpt","callbackURL":"/success"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let authorization = Url::parse(result["url"].as_str().unwrap()).unwrap();
    let query = authorization
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_ne!(query["code_challenge"], challenge);
    let cookies = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|value| value.to_str().unwrap().split(';').next().unwrap())
        .collect::<Vec<_>>()
        .join("; ");
    let callback = format!(
        "/api/auth/callback/chatgpt?state={}&code=fixture-code",
        query["state"]
    );
    let (status, headers, _) = fixture
        .request("GET", &callback, Some(&cookies), None)
        .await;
    assert_eq!(status, StatusCode::FOUND);
    let transfer = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .find_map(|value| {
            value
                .to_str()
                .ok()?
                .strip_prefix("better-auth.electron=")
                .map(|value| value.split(';').next().unwrap())
        })
        .unwrap();
    let transfer: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(transfer).unwrap()).unwrap();
    assert_eq!(transfer["state"], "native-state");
    let request = Request::post("/api/auth/electron/token")
        .header("electron-origin", "com.forge.desktop:/")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({"token":transfer["identifier"],"state":"native-state","code_verifier":verifier})
                .to_string(),
        ))
        .unwrap();
    let response = fixture.app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}
