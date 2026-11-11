use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderMap, Response, StatusCode},
    routing::post,
};
use forge_core::invitations::Effect;
use forge_server::mail::{InvitationMessage, ResendMailer, VerificationMailer, invitation_payload};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

fn invitation() -> InvitationMessage {
    InvitationMessage {
        id: "fixture-invitation".into(),
        email: "delivered@resend.dev".into(),
        role: "member".into(),
        organization_name: "Fixture".into(),
        inviter_name: "Ada".into(),
        inviter_email: "ada@example.test".into(),
        url: "https://forge.example.test/accept-invitation?id=fixture-invitation".into(),
    }
}

#[test]
fn initial_and_reminder_mail_match_source_text_headers_and_html() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../forge-core/data/invitation-reference.json"
    ))
    .unwrap();
    for case in fixture["messages"].as_array().unwrap() {
        let input = &case["input"];
        let string = |name: &str| input[name].as_str().unwrap().to_owned();
        let mut url = url::Url::parse(input["appUrl"].as_str().unwrap())
            .unwrap()
            .join("/accept-invitation")
            .unwrap();
        url.query_pairs_mut()
            .append_pair("id", input["id"].as_str().unwrap());
        let message = InvitationMessage {
            id: string("id"),
            email: string("email"),
            role: string("role"),
            organization_name: string("organizationName"),
            inviter_name: string("inviterName"),
            inviter_email: string("inviterEmail"),
            url: url.into(),
        };
        let effect = if input["reminder"] == true {
            Effect::Reminder
        } else {
            Effect::Initial
        };
        let mut payload =
            invitation_payload("Forge <fixture@example.test>", &message, effect).unwrap();
        let html = payload.as_object_mut().unwrap().remove("html").unwrap();
        assert_eq!(
            hex::encode(Sha256::digest(html.as_str().unwrap().as_bytes())),
            case["htmlHash"],
            "{input}"
        );
        assert_eq!(payload, case["payload"]);
        assert_eq!(effect.key(&message.id), case["key"]);
    }
}

#[derive(Clone)]
struct Provider {
    response: Arc<Mutex<(StatusCode, String)>>,
    requests: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
}
impl Provider {
    async fn new() -> (Self, url::Url, tokio::task::JoinHandle<()>) {
        let provider = Self {
            response: Arc::new(Mutex::new((
                StatusCode::OK,
                json!({"id":"fixture-delivery"}).to_string(),
            ))),
            requests: Arc::default(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/emails", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let router = Router::new()
            .route(
                "/emails",
                post(
                    |State(p): State<Provider>,
                     headers: HeaderMap,
                     axum::Json(body): axum::Json<Value>| async move {
                        p.requests.lock().unwrap().push((headers, body));
                        let (status, body) = p.response.lock().unwrap().clone();
                        Response::builder()
                            .status(status)
                            .header("location", "/emails")
                            .header("content-type", "application/json")
                            .body(Body::from(body))
                            .unwrap()
                    },
                ),
            )
            .with_state(provider.clone());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (provider, endpoint, task)
    }
    fn set(&self, status: StatusCode, body: String) {
        *self.response.lock().unwrap() = (status, body);
    }
}
fn mailer(endpoint: url::Url) -> ResendMailer {
    ResendMailer::new(
        " fixture-private-token ".into(),
        "Forge <fixture@example.test>".into(),
        false,
        false,
        endpoint,
    )
    .unwrap()
}

#[tokio::test]
async fn provider_receipts_and_stable_effect_keys_cross_the_actual_http_boundary() {
    let (provider, endpoint, task) = Provider::new().await;
    let transport = mailer(endpoint.clone());
    let message = invitation();
    for effect in [Effect::Initial, Effect::Initial, Effect::Reminder] {
        assert_eq!(
            transport
                .send_invitation_effect(&message, effect)
                .await
                .unwrap(),
            "fixture-delivery"
        );
    }
    // Synchronous mail shares rendering/validation but has no durable identity.
    transport.send_invitation(&message).await.unwrap();
    let requests = provider.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 4);
    assert_eq!(
        requests[0].0["idempotency-key"],
        Effect::Initial.key(&message.id)
    );
    assert_eq!(
        requests[0].0["idempotency-key"],
        requests[1].0["idempotency-key"]
    );
    assert_eq!(requests[0].1, requests[1].1);
    assert_eq!(
        requests[2].0["idempotency-key"],
        Effect::Reminder.key(&message.id)
    );
    assert!(!requests[3].0.contains_key("idempotency-key"));
    assert!(
        requests
            .iter()
            .all(|(headers, _)| headers["authorization"] == "Bearer fixture-private-token")
    );
    assert_eq!(
        requests[2].1["subject"],
        "Reminder: your invitation to Fixture on Forge"
    );
    task.abort();
    let _ = task.await;
    let error = mailer(endpoint)
        .send_invitation_effect(&message, Effect::Initial)
        .await
        .unwrap_err();
    assert!(error.retryable);
    assert_eq!(error.status_code, None);
}

#[tokio::test]
async fn provider_failures_are_bounded_redacted_and_do_not_follow_redirects() {
    let (provider, endpoint, task) = Provider::new().await;
    let transport = mailer(endpoint);
    for (http, body, retry, code) in [
        (
            429,
            json!({"statusCode":429,"name":"rate_limit_exceeded","message":"private recipient"})
                .to_string(),
            true,
            Some(429),
        ),
        (
            422,
            json!({"statusCode":422,"name":"validation_error","message":"private recipient"})
                .to_string(),
            false,
            Some(422),
        ),
        (
            409,
            json!({"statusCode":409,"name":"concurrent_idempotent_requests"}).to_string(),
            true,
            Some(409),
        ),
        (
            409,
            json!({"statusCode":409,"name":"invalid_idempotent_request"}).to_string(),
            false,
            Some(409),
        ),
        (
            307,
            json!({"statusCode":307,"name":"validation_error"}).to_string(),
            false,
            Some(307),
        ),
        (503, "not json private recipient".into(), true, Some(503)),
        (500, "x".repeat(65537), true, Some(500)),
        (200, "{}".into(), true, None),
        (200, json!({"id":"x".repeat(1025)}).to_string(), true, None),
        (
            200,
            json!({"id":"private\nrecipient"}).to_string(),
            true,
            None,
        ),
    ] {
        provider.set(StatusCode::from_u16(http).unwrap(), body);
        let before = provider.requests.lock().unwrap().len();
        let error = transport
            .send_invitation_effect(&invitation(), Effect::Initial)
            .await
            .unwrap_err();
        assert_eq!((error.retryable, error.status_code), (retry, code));
        assert!(!format!("{error:?} {error}").contains("private"));
        assert_eq!(provider.requests.lock().unwrap().len(), before + 1);
    }
    task.abort();
}

#[tokio::test]
async fn staging_and_invalid_delivery_configuration_fail_before_network_io() {
    let (provider, endpoint, task) = Provider::new().await;
    for (from, sandbox, email, allowed) in [
        (
            "Forge staging <staging@nexstudio.io>",
            true,
            "delivered@resend.dev",
            true,
        ),
        (
            "Forge staging <staging@nexstudio.io>",
            true,
            "bounced@resend.dev",
            true,
        ),
        (
            "Forge staging <staging@nexstudio.io>",
            true,
            "complained@resend.dev",
            true,
        ),
        (
            "Forge staging <staging@nexstudio.io>",
            true,
            "real@example.test",
            false,
        ),
        (
            "Forge staging <staging@nexstudio.io>",
            false,
            "delivered@resend.dev",
            false,
        ),
        (
            "Forge <fixture@example.test>",
            true,
            "delivered@resend.dev",
            false,
        ),
    ] {
        let transport = ResendMailer::new(
            "fixture-token".into(),
            from.into(),
            true,
            sandbox,
            endpoint.clone(),
        )
        .unwrap();
        let mut message = invitation();
        message.email = email.into();
        let before = provider.requests.lock().unwrap().len();
        assert_eq!(
            transport
                .send_invitation_effect(&message, Effect::Initial)
                .await
                .is_ok(),
            allowed
        );
        assert_eq!(
            provider.requests.lock().unwrap().len(),
            before + usize::from(allowed)
        );
    }
    let transport = mailer(endpoint.clone());
    for invalid in ["bad\nkey".into(), "x".repeat(257)] {
        let mut message = invitation();
        message.id = invalid;
        let before = provider.requests.lock().unwrap().len();
        assert!(
            !transport
                .send_invitation_effect(&message, Effect::Initial)
                .await
                .unwrap_err()
                .retryable
        );
        assert_eq!(provider.requests.lock().unwrap().len(), before);
    }
    for invalid in [
        "http://example.test/emails",
        "https://user:password@example.test/emails",
        "https://example.test/emails?credential=private",
        "https://example.test/emails#fragment",
        "file:///tmp/emails",
    ] {
        assert!(
            ResendMailer::new(
                "fixture".into(),
                "Fixture".into(),
                false,
                false,
                invalid.parse().unwrap()
            )
            .is_err()
        );
    }
    assert!(
        ResendMailer::new(" ".into(), "Fixture".into(), false, false, endpoint.clone()).is_err()
    );
    assert!(ResendMailer::new("fixture".into(), " ".into(), false, false, endpoint).is_err());
    task.abort();
}
