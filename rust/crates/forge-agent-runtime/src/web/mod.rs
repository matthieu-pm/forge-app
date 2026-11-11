//! Public web retrieval is a separate, credential-free authority from sandbox
//! execution. The transport pins checked DNS answers and never follows redirects.
mod dom;
pub mod html;
mod http;
use crate::sandbox::Cancellation;
use async_trait::async_trait;
pub use http::{Http, Resolver, SystemResolver};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use url::Url;
#[derive(Debug, thiserror::Error)]
pub enum Failure {
    #[error("Invalid web-fetch input.")]
    Input,
    #[error("URL must be a valid absolute https:// URL.")]
    Url,
    #[error("URL must start with https://")]
    Scheme,
    #[error("URL must not target localhost, private, link-local, or reserved IP addresses.")]
    Private,
    #[error("URLs containing credentials are not supported.")]
    Credentials,
    #[error("Request redirected to {0}. Call web_fetch again with that URL.")]
    Redirect(String),
    #[error("Request failed with status code: {0}")]
    Status(u16),
    #[error("Response too large (exceeds 5 MB limit).")]
    Size,
    #[error("The webpage is too complex to convert safely.")]
    ComplexHtml,
    #[error("The webpage could not be fetched.")]
    Transport,
    #[error("Web retrieval cancelled.")]
    Cancelled,
    #[error("Web retrieval timed out.")]
    Timeout,
    #[error("The web-fetch timeout must be a nonnegative whole number of milliseconds.")]
    TimeoutInput,
}
pub const MAX_BODY: usize = 5 * 1024 * 1024;
pub struct Response {
    pub status: u16,
    pub content_type: String,
    pub location: Option<String>,
    pub challenge: bool,
    pub body: Vec<u8>,
}
#[async_trait]
pub trait Transport: Send + Sync {
    async fn request(
        &self,
        url: &Url,
        accept: &str,
        challenge_retry: bool,
        cancellation: &Cancellation,
    ) -> Result<Response, Failure>;
}
pub struct Executor {
    pub transport: Arc<dyn Transport>,
}
impl Default for Executor {
    fn default() -> Self {
        Self {
            transport: Arc::new(Http::default()),
        }
    }
}
pub fn parse_url(value: &str) -> Result<Url, Failure> {
    let url = Url::parse(value).map_err(|_| Failure::Url)?;
    if url.scheme() != "https" {
        return Err(Failure::Scheme);
    }
    if url.host_str().is_none() {
        return Err(Failure::Url);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Failure::Credentials);
    }
    Ok(url)
}
pub fn public_host(url: &Url) -> Result<(), Failure> {
    let host = url.host_str().ok_or(Failure::Url)?;
    if forge_core::agents::web::private(host) || forge_core::agents::web::loopback(host) {
        return Err(Failure::Private);
    }
    Ok(())
}
pub fn accept(format: &str) -> &'static str {
    match format {
        "text" => "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1",
        "html" => {
            "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
        }
        _ => {
            "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
        }
    }
}
fn bounded_response(response: Response, url: &Url) -> Result<Response, Failure> {
    if [301, 302, 303, 307, 308].contains(&response.status)
        && let Some(location) = &response.location
    {
        let target = url.join(location).map_err(|_| Failure::Url)?;
        let target = parse_url(target.as_str())?;
        return Err(Failure::Redirect(target.to_string()));
    }
    if response.body.len() > MAX_BODY {
        return Err(Failure::Size);
    }
    Ok(response)
}
impl Executor {
    pub async fn execute(
        &self,
        input: Value,
        cancellation: &Cancellation,
    ) -> Result<Value, Failure> {
        let input =
            forge_core::agents::web::input("web_fetch", input).map_err(|_| Failure::Input)?;
        let milliseconds = (input["timeout"]
            .as_f64()
            .map(|n| n * 1000.)
            .unwrap_or(30_000.))
        .min(120_000.);
        if !milliseconds.is_finite() || milliseconds < 0. || milliseconds.fract() != 0. {
            return Err(Failure::TimeoutInput);
        }
        let execution = self.execute_inner(&input, cancellation);
        tokio::select! {biased;()=cancellation.cancelled()=>Err(Failure::Cancelled),result=tokio::time::timeout(Duration::from_millis(milliseconds as u64),execution)=>result.map_err(|_|Failure::Timeout)?,}
    }
    async fn execute_inner(
        &self,
        input: &Value,
        cancellation: &Cancellation,
    ) -> Result<Value, Failure> {
        let original = input["url"].as_str().ok_or(Failure::Input)?;
        let url = parse_url(original)?;
        public_host(&url)?;
        let format = input["format"].as_str().unwrap_or("markdown");
        let mut response = bounded_response(
            self.transport
                .request(&url, accept(format), false, cancellation)
                .await?,
            &url,
        )?;
        if response.status == 403 && response.challenge {
            response = bounded_response(
                self.transport
                    .request(&url, accept(format), true, cancellation)
                    .await?,
                &url,
            )?;
        }
        if !(200..300).contains(&response.status) {
            return Err(Failure::Status(response.status));
        }
        let decoded = String::from_utf8_lossy(&response.body);
        let decoded = decoded.strip_prefix('\u{feff}').unwrap_or(&decoded);
        let content = if response.content_type.contains("text/html") {
            match format {
                "markdown" => html::markdown(decoded)?,
                "text" => html::plain(decoded),
                _ => decoded.into(),
            }
        } else {
            decoded.into()
        };
        if cancellation.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        let (content, truncated) = head(&content);
        Ok(
            json!({"content":content,"contentType":response.content_type,"truncated":truncated,"url":original}),
        )
    }
}
pub fn head(value: &str) -> (String, bool) {
    let lines = value.split('\n').collect::<Vec<_>>();
    let total = lines.len() - usize::from(lines.last() == Some(&""));
    let mut output = Vec::new();
    let mut bytes = 0;
    for line in lines.into_iter().take(2000) {
        let units = line.encode_utf16().take(2001).collect::<Vec<_>>();
        let line = if units.len() <= 2000 {
            line.into()
        } else {
            format!("{} [truncated]", String::from_utf16_lossy(&units[..2000]))
        };
        let size = line.len() + 1;
        if bytes + size > 50 * 1024 && !output.is_empty() {
            break;
        }
        bytes += size;
        output.push(line);
    }
    let truncated = output.len() < total;
    (output.join("\n"), truncated)
}
