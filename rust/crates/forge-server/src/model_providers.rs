//! Bounded provider discovery. Custom DNS answers are validated and pinned to
//! the request; redirects and inherited proxy settings cannot bypass the fence.
use async_trait::async_trait;
use forge_core::agents::providers::{
    self as policy, Code, Discovery, DiscoveryInput, Error, Model,
};
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use url::Url;

#[async_trait]
pub trait Resolver: Send + Sync {
    async fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, Error>;
}
struct SystemResolver;
#[async_trait]
impl Resolver for SystemResolver {
    async fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, Error> {
        tokio::time::timeout(
            Duration::from_secs(10),
            tokio::net::lookup_host((host, 443)),
        )
        .await
        .map_err(|_| invalid_endpoint())?
        .map(|rows| rows.map(|r| r.ip()).collect())
        .map_err(|_| invalid_endpoint())
    }
}
pub struct Endpoint {
    pub url: Url,
    pub addresses: Vec<SocketAddr>,
}
pub struct ProviderDiscovery {
    resolver: Arc<dyn Resolver>,
}
impl Default for ProviderDiscovery {
    fn default() -> Self {
        Self {
            resolver: Arc::new(SystemResolver),
        }
    }
}
impl ProviderDiscovery {
    pub fn with_resolver(resolver: Arc<dyn Resolver>) -> Self {
        Self { resolver }
    }
    pub async fn endpoint(&self, value: &str) -> Result<Endpoint, Error> {
        let url = policy::endpoint(value)?;
        let host = url
            .host_str()
            .ok_or_else(invalid_endpoint)?
            .trim_start_matches('[')
            .trim_end_matches(']');
        let addresses = match host.parse::<IpAddr>() {
            Ok(ip) => vec![ip],
            Err(_) => self.resolver.resolve(host).await?,
        };
        if addresses.is_empty()
            || addresses
                .iter()
                .any(|ip| policy::private_address(&ip.to_string()))
        {
            return Err(invalid_endpoint());
        }
        Ok(Endpoint {
            url,
            addresses: addresses
                .into_iter()
                .map(|ip| SocketAddr::new(ip, 443))
                .collect(),
        })
    }
    async fn fetch_catalog(&self, input: &DiscoveryInput) -> Result<serde_json::Value, Error> {
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(Duration::from_secs(10));
        let endpoint = if let Some(url) = policy::built_in(&input.provider) {
            Url::parse(url).map_err(|_| discovery_failed())?
        } else {
            let endpoint = self
                .endpoint(input.endpoint_url.as_deref().unwrap_or(""))
                .await?;
            builder = builder.resolve_to_addrs(
                endpoint.url.host_str().ok_or_else(invalid_endpoint)?,
                &endpoint.addresses,
            );
            endpoint.url
        };
        let mut request = builder
            .build()
            .map_err(|_| discovery_failed())?
            .get(endpoint.join("models").map_err(|_| discovery_failed())?)
            .header("accept", "application/json");
        for (name, value) in policy::headers(&input.provider, &input.api_key) {
            request = request.header(name, value);
        }
        let response = request.send().await.map_err(|_| discovery_failed())?;
        read_catalog(response).await
    }
}
fn invalid_endpoint() -> Error {
    Error::new(
        Code::InvalidEndpoint,
        "Custom provider endpoints must resolve only to public network addresses.",
    )
}
fn discovery_failed() -> Error {
    Error::new(
        Code::DiscoveryFailed,
        "Forge could not authenticate with this provider or discover its models.",
    )
}
async fn read_catalog(mut response: reqwest::Response) -> Result<serde_json::Value, Error> {
    if response.content_length().is_some_and(|n| n > 2_000_000) {
        return Err(discovery_failed());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| discovery_failed())? {
        // At most three UTF-8 bytes per UTF-16 code unit. The source applies a
        // two-million-code-unit text limit in addition to Content-Length.
        if bytes.len() + chunk.len() > 6_000_000 {
            return Err(discovery_failed());
        }
        bytes.extend(chunk);
    }
    let decoded = String::from_utf8_lossy(&bytes);
    let text = decoded.strip_prefix('\u{feff}').unwrap_or(&decoded);
    if !response.status().is_success() || text.encode_utf16().count() > 2_000_000 {
        return Err(discovery_failed());
    }
    forge_core::json::parse(text).map_err(|_| discovery_failed())
}
#[async_trait]
impl Discovery for ProviderDiscovery {
    async fn validate_endpoint(&self, value: &str) -> Result<String, Error> {
        Ok(self.endpoint(value).await?.url.to_string())
    }
    async fn discover(&self, input: &DiscoveryInput) -> Result<Vec<Model>, Error> {
        // Endpoint validation precedes manual fallback in the owning service;
        // never let manual IDs suppress private-address rejection here either.
        match self.fetch_catalog(input).await {
            Ok(payload) => Ok(policy::normalize(
                &input.provider,
                Some(&payload),
                &input.model_ids,
            )),
            Err(error)
                if error.code != Code::InvalidEndpoint
                    && input.model_ids.iter().any(|s| policy::text_model(s)) =>
            {
                Ok(policy::normalize(&input.provider, None, &input.model_ids))
            }
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::Body,
        http::{Response, StatusCode},
        routing::get,
    };
    use serde_json::json;
    struct Dns(Vec<IpAddr>);
    #[async_trait]
    impl Resolver for Dns {
        async fn resolve(&self, _: &str) -> Result<Vec<IpAddr>, Error> {
            Ok(self.0.clone())
        }
    }
    #[tokio::test]
    async fn endpoints_pin_only_public_addresses_and_manual_models_cannot_bypass_dns_rejection() {
        let public: IpAddr = "8.8.8.8".parse().unwrap();
        let private: IpAddr = "127.0.0.1".parse().unwrap();
        for records in [vec![], vec![private], vec![public, private]] {
            let provider = ProviderDiscovery::with_resolver(Arc::new(Dns(records)));
            assert!(provider.endpoint("https://provider.test/v1").await.is_err());
            let input = DiscoveryInput {
                provider: "custom-openai".into(),
                api_key: "fixture".into(),
                endpoint_url: Some("https://provider.test/v1".into()),
                model_ids: vec!["manual".into()],
            };
            assert_eq!(
                provider.discover(&input).await.unwrap_err().code,
                Code::InvalidEndpoint
            );
        }
        let provider = ProviderDiscovery::with_resolver(Arc::new(Dns(vec![
            public,
            "2001:4860:4860::8888".parse().unwrap(),
        ])));
        let endpoint = provider
            .endpoint("https://provider.test/v1?private=key#fragment")
            .await
            .unwrap();
        assert_eq!(endpoint.url.as_str(), "https://provider.test/v1/");
        assert_eq!(endpoint.addresses[0], SocketAddr::new(public, 443));
        assert_eq!(endpoint.addresses.len(), 2);
        for url in [
            "https://127.0.0.1",
            "https://[::1]",
            "https://[0:0:0:0:0:0:0:1]",
            "https://[::ffff:8.8.8.8]",
            "http://provider.test",
            "https://provider.test:444",
            "https://user:pass@provider.test",
        ] {
            assert!(provider.endpoint(url).await.is_err(), "{url}");
        }
    }
    #[tokio::test]
    async fn model_http_responses_bound_bytes_text_status_and_json() {
        let app = Router::new()
            .route(
                "/ok",
                get(|| async { Response::new(Body::from("\u{feff}{\"data\":[]}")) }),
            )
            .route("/invalid", get(|| async { "invalid" }))
            .route(
                "/denied",
                get(|| async { (StatusCode::UNAUTHORIZED, "private provider diagnostic") }),
            )
            .route(
                "/redirect",
                get(|| async {
                    (
                        StatusCode::FOUND,
                        [("location", "http://127.0.0.1/private")],
                        "{}",
                    )
                }),
            )
            .route(
                "/large",
                get(|| async {
                    Response::new(Body::from_stream(futures_util::stream::iter([Ok::<
                        _,
                        std::io::Error,
                    >(
                        "x".repeat(2_000_001),
                    )])))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        for (path, ok) in [
            ("ok", true),
            ("invalid", false),
            ("denied", false),
            ("redirect", false),
            ("large", false),
        ] {
            let response = client
                .get(format!("http://{address}/{path}"))
                .send()
                .await
                .unwrap();
            let result = read_catalog(response).await;
            assert_eq!(result.is_ok(), ok, "{path}");
            if let Ok(value) = result {
                assert_eq!(value, json!({"data":[]}));
            } else {
                assert!(
                    !result
                        .unwrap_err()
                        .message
                        .contains("private provider diagnostic")
                );
            }
        }
        task.abort();
    }
}
