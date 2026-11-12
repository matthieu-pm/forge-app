use super::*;
use std::time::Duration;
use url::Url;

const RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
const QUERY_KEYS: &[&str] = &[
    "subscription_id",
    "external_customer_id",
    "product_id",
    "status",
    "created_before",
    "sorting",
    "limit",
    "page",
];
fn invalid() -> Error {
    Error("BILLING_PROVIDER_REQUEST_INVALID")
}
pub fn build_request(
    environment: &str,
    operation: Operation,
    body: Option<Value>,
    query: Vec<(String, String)>,
) -> Result<Request, Error> {
    let origin = match environment {
        "production" => "https://api.polar.sh",
        "sandbox" => "https://sandbox-api.polar.sh",
        _ => return Err(Error("INVALID_BILLING_CONFIGURATION")),
    };
    let (method, path) = match operation {
        Operation::Product(id)
        | Operation::Subscription(id)
        | Operation::Order(id)
        | Operation::UpdateSubscription(id)
        | Operation::ReadCheckout(id)
            if !forge_core::text::is_uuid(&id) =>
        {
            return Err(Error("INVALID_BILLING_INPUT"));
        }
        Operation::Product(id) => ("GET", format!("/v1/products/{id}")),
        Operation::Subscription(id) => ("GET", format!("/v1/subscriptions/{id}")),
        Operation::UpdateSubscription(id) => ("PATCH", format!("/v1/subscriptions/{id}")),
        Operation::ReadCheckout(id) => ("GET", format!("/v1/checkouts/{id}")),
        Operation::Order(id) => ("GET", format!("/v1/orders/{id}")),
        Operation::Orders => ("GET", "/v1/orders/".into()),
        Operation::Checkout => ("POST", "/v1/checkouts/".into()),
        Operation::Portal => ("POST", "/v1/customer-sessions/".into()),
    };
    let mut url = Url::parse(&format!("{origin}{path}")).map_err(|_| invalid())?;
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    let request = Request {
        method: method.into(),
        url: url.into(),
        body,
    };
    validate(&request)?;
    Ok(request)
}
fn validate(request: &Request) -> Result<(), Error> {
    let url = Url::parse(&request.url).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || !["api.polar.sh", "sandbox-api.polar.sh"].contains(&url.host_str().unwrap_or(""))
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    let path = url.path();
    let is_list = path == "/v1/orders/";
    let get = is_list
        || [
            "/v1/products/",
            "/v1/subscriptions/",
            "/v1/orders/",
            "/v1/checkouts/",
        ]
        .iter()
        .any(|prefix| {
            path.strip_prefix(prefix)
                .is_some_and(forge_core::text::is_uuid)
        });
    let post = ["/v1/checkouts/", "/v1/customer-sessions/"].contains(&path);
    let patch = path
        .strip_prefix("/v1/subscriptions/")
        .is_some_and(forge_core::text::is_uuid)
        && request.body.as_ref().is_some_and(subscription_patch);
    if !((request.method == "GET" && get && request.body.is_none())
        || (request.method == "POST"
            && post
            && request.body.as_ref().is_some_and(Value::is_object))
        || (request.method == "PATCH" && patch))
        || (!is_list && url.query().is_some())
        || url
            .query_pairs()
            .any(|(key, _)| !QUERY_KEYS.contains(&key.as_ref()))
    {
        return Err(invalid());
    }
    Ok(())
}
fn subscription_patch(value: &Value) -> bool {
    let Some(fields) = value.as_object() else {
        return false;
    };
    if fields.len() == 1 {
        return value.get("cancel_at_period_end") == Some(&Value::Bool(true))
            || value.get("pending_update") == Some(&Value::Null);
    }
    if fields.len() != 2 {
        return false;
    }
    if let Some(id) = value.get("product_id").and_then(Value::as_str) {
        return forge_core::text::is_uuid(id)
            && ["invoice", "next_period"]
                .iter()
                .any(|v| value["proration_behavior"] == *v);
    }
    value["proration_behavior"] == "next_period"
        && forge_core::billing::safe_integer(&value["seats"], 1).is_ok()
}
pub struct HttpTransport(reqwest::Client);
impl HttpTransport {
    pub fn new() -> Result<Self, Error> {
        Ok(Self(
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|_| Error("BILLING_PROVIDER_UNAVAILABLE"))?,
        ))
    }
    fn prepare(&self, request: Request, token: &str) -> Result<reqwest::RequestBuilder, Error> {
        validate(&request)?;
        if forge_core::text::trim(token).is_empty() {
            return Err(invalid());
        }
        let method =
            reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|_| invalid())?;
        let mut outgoing = self
            .0
            .request(method, request.url)
            .bearer_auth(token)
            .header("Content-Type", "application/json")
            .header("Polar-Version", "2026-10");
        if let Some(body) = request.body {
            outgoing = outgoing.json(&body);
        }
        Ok(outgoing)
    }
}
#[async_trait]
impl Transport for HttpTransport {
    async fn execute(&self, request: Request, token: &str) -> Result<Value, Error> {
        let outgoing = self.prepare(request, token)?;
        // No automatic retries: a lost response never authorizes repeating a
        // provider-side creation or changing a paid contract a second time.
        let response = outgoing
            .send()
            .await
            .map_err(|_| Error("BILLING_PROVIDER_UNAVAILABLE"))?;
        read_response(response).await
    }
}

async fn read_response(mut response: reqwest::Response) -> Result<Value, Error> {
    let failed = || Error("BILLING_PROVIDER_UNAVAILABLE");
    if !response.status().is_success() {
        return Err(failed());
    }
    if response
        .content_length()
        .is_some_and(|n| n > RESPONSE_LIMIT as u64)
    {
        return Err(failed());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| failed())? {
        if bytes.len() + chunk.len() > RESPONSE_LIMIT {
            return Err(failed());
        }
        bytes.extend_from_slice(&chunk);
    }
    let raw = std::str::from_utf8(&bytes).map_err(|_| failed())?;
    forge_core::json::parse(raw).map_err(|_| failed())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn actual_http_requests_match_pinned_sdk_wire_fixtures() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../forge-core/data/billing-provider-reference.json"
        ))
        .unwrap();
        let http = HttpTransport::new().unwrap();
        for case in fixture["wire"].as_array().unwrap() {
            let id = case["id"].as_str().unwrap().into();
            let operation = match case["operation"].as_str().unwrap() {
                "product" => Operation::Product(id),
                "subscription" => Operation::Subscription(id),
                "order" => Operation::Order(id),
                "orders" => Operation::Orders,
                "checkout" => Operation::Checkout,
                "portal" => Operation::Portal,
                "read-checkout" => Operation::ReadCheckout(id),
                "update-cancel" | "update-product" | "update-seats" | "update-clear" => {
                    Operation::UpdateSubscription(id)
                }
                _ => panic!(),
            };
            let query = serde_json::from_value(case["query"].clone()).unwrap();
            let body = (!case["body"].is_null()).then(|| case["body"].clone());
            let request = build_request(
                case["environment"].as_str().unwrap(),
                operation,
                body,
                query,
            )
            .unwrap();
            let outgoing = http
                .prepare(request, "fixture-token")
                .unwrap()
                .build()
                .unwrap();
            let mut headers = serde_json::Map::new();
            for (name, value) in outgoing.headers() {
                headers.insert(name.to_string(), json!(value.to_str().unwrap()));
            }
            let body = outgoing
                .body()
                .map(|v| serde_json::from_slice::<Value>(v.as_bytes().unwrap()).unwrap())
                .unwrap_or(Value::Null);
            assert_eq!(
                json!({"url":outgoing.url().as_str(),"method":outgoing.method().as_str(),"headers":headers,"body":body}),
                case["request"]
            );
        }
    }

    #[tokio::test]
    async fn credential_transport_rejects_foreign_destinations_and_unowned_operations_before_io() {
        let transport = HttpTransport::new().unwrap();
        let id = "00000000-0000-4000-8000-000000000001";
        for url in [
            "http://api.polar.sh/v1/orders/".to_owned(),
            "https://api.polar.sh.evil.test/v1/orders/".into(),
            "https://other.test/v1/orders/".into(),
            "https://secret@api.polar.sh/v1/orders/".into(),
            "https://api.polar.sh:444/v1/orders/".into(),
            "https://api.polar.sh/v1/orders/?url=secret".into(),
            "https://api.polar.sh/v1/refunds/".into(),
            "https://api.polar.sh/v1/orders/#fragment".into(),
            format!("https://api.polar.sh/v1/products/{id}?page=1"),
            "https://api.polar.sh/v1/products/not-uuid".into(),
        ] {
            assert_eq!(
                transport
                    .execute(
                        Request {
                            method: "GET".into(),
                            url,
                            body: None
                        },
                        "never-send-token"
                    )
                    .await
                    .unwrap_err()
                    .0,
                "BILLING_PROVIDER_REQUEST_INVALID"
            );
        }
        for method in ["PATCH", "DELETE", "POST"] {
            assert!(
                transport
                    .execute(
                        Request {
                            method: method.into(),
                            url: format!("https://api.polar.sh/v1/subscriptions/{id}"),
                            body: Some(json!({}))
                        },
                        "token"
                    )
                    .await
                    .is_err()
            );
        }
        assert!(build_request("preview", Operation::Orders, None, vec![]).is_err());
        assert!(
            build_request(
                "sandbox",
                Operation::Order("../checkouts/".into()),
                None,
                vec![]
            )
            .is_err()
        );
        assert!(build_request("sandbox", Operation::Checkout, None, vec![]).is_err());
        assert!(build_request("sandbox", Operation::Orders, Some(json!({})), vec![]).is_err());
        // Only the source-owned renewal/cancellation mutations may cross this
        // credential boundary. Reject entitlements, money and mixed updates.
        for body in [
            json!({"cancel_at_period_end":false}),
            json!({"cancel_at_period_end":true,"amount":1}),
            json!({"pending_update":{}}),
            json!({"pending_update":null,"seats":2}),
            json!({"product_id":id,"proration_behavior":"prorate"}),
            json!({"product_id":"../products/","proration_behavior":"invoice"}),
            json!({"product_id":id,"proration_behavior":"invoice","seats":1}),
            json!({"seats":2,"proration_behavior":"invoice"}),
            json!({"seats":0,"proration_behavior":"next_period"}),
            json!({"seats":1.5,"proration_behavior":"next_period"}),
            json!({"seats":9007199254740992_u64,"proration_behavior":"next_period"}),
            json!({"amount":1000,"proration_behavior":"next_period"}),
        ] {
            assert_eq!(
                build_request(
                    "sandbox",
                    Operation::UpdateSubscription(id.into()),
                    Some(body),
                    vec![]
                )
                .unwrap_err()
                .0,
                "BILLING_PROVIDER_REQUEST_INVALID"
            );
        }
    }

    async fn local_response(status: u16, body: Vec<u8>, chunked: bool) -> reqwest::Response {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut input = [0; 4096];
            let mut received = Vec::new();
            loop {
                let amount = stream.read(&mut input).await.unwrap();
                if amount == 0 {
                    return;
                }
                received.extend_from_slice(&input[..amount]);
                if received.windows(4).any(|part| part == b"\r\n\r\n") {
                    break;
                }
                assert!(
                    received.len() <= 8192,
                    "Fixture request headers exceeded bound"
                );
            }
            let head = if chunked {
                format!(
                    "HTTP/1.1 {status} Fixture\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                )
            } else {
                format!(
                    "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
            };
            if stream.write_all(head.as_bytes()).await.is_err() {
                return;
            }
            if chunked {
                for bytes in body.chunks(65536) {
                    if stream
                        .write_all(format!("{:x}\r\n", bytes.len()).as_bytes())
                        .await
                        .is_err()
                        || stream.write_all(bytes).await.is_err()
                        || stream.write_all(b"\r\n").await.is_err()
                    {
                        return;
                    }
                }
                let _ = stream.write_all(b"0\r\n\r\n").await;
            } else {
                let _ = stream.write_all(&body).await;
            }
        });
        reqwest::get(format!("http://{address}/")).await.unwrap()
    }
    #[tokio::test]
    async fn provider_response_body_is_bounded_and_errors_do_not_expose_provider_data() {
        for chunked in [false, true] {
            assert_eq!(
                read_response(local_response(200, b"{\"ok\":true}".to_vec(), chunked).await)
                    .await
                    .unwrap(),
                json!({"ok":true})
            );
            assert_eq!(
                read_response(local_response(200, vec![b'x'; RESPONSE_LIMIT + 1], chunked).await)
                    .await
                    .unwrap_err()
                    .0,
                "BILLING_PROVIDER_UNAVAILABLE"
            );
        }
        for (status, body) in [
            (401, b"private-token".to_vec()),
            (429, b"private-customer".to_vec()),
            (503, b"private-provider-error".to_vec()),
            (302, b"{}".to_vec()),
            (200, b"invalid json".to_vec()),
            (200, vec![255]),
        ] {
            assert_eq!(
                read_response(local_response(status, body, false).await)
                    .await
                    .unwrap_err()
                    .to_string(),
                "BILLING_PROVIDER_UNAVAILABLE"
            );
        }
    }
}
