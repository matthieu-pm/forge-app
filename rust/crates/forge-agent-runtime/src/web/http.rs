use super::{Failure, MAX_BODY, Response, Transport, parse_url, public_host};
use crate::sandbox::Cancellation;
use async_trait::async_trait;
use std::{
    io::{Cursor, Read},
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use url::{Host, Url};
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
#[async_trait]
pub trait Resolver: Send + Sync {
    async fn lookup(&self, host: &str) -> Result<Vec<IpAddr>, Failure>;
}
pub struct SystemResolver;
#[async_trait]
impl Resolver for SystemResolver {
    async fn lookup(&self, host: &str) -> Result<Vec<IpAddr>, Failure> {
        let (config, mut options) =
            hickory_resolver::system_conf::read_system_conf().map_err(|_| Failure::Transport)?;
        options.ip_strategy = hickory_resolver::config::LookupIpStrategy::Ipv4AndIpv6;
        let resolver = hickory_resolver::TokioAsyncResolver::tokio(config, options);
        let result = resolver
            .lookup_ip(host)
            .await
            .map_err(|_| Failure::Transport)?;
        Ok(result.iter().collect())
    }
}
pub struct Http {
    pub resolver: Arc<dyn Resolver>,
}
impl Default for Http {
    fn default() -> Self {
        Self {
            resolver: Arc::new(SystemResolver),
        }
    }
}
impl Http {
    async fn addresses(&self, url: &Url) -> Result<Vec<SocketAddr>, Failure> {
        public_host(url)?;
        let addresses = match url.host().ok_or(Failure::Url)? {
            Host::Ipv4(a) => vec![IpAddr::V4(a)],
            Host::Ipv6(a) => vec![IpAddr::V6(a)],
            Host::Domain(host) => self.resolver.lookup(host).await?,
        };
        if addresses.is_empty() || addresses.len() > 64 {
            return Err(Failure::Transport);
        }
        if addresses
            .iter()
            .any(|a| forge_core::agents::web::private(&a.to_string()))
        {
            return Err(Failure::Private);
        }
        Ok(addresses
            .into_iter()
            .map(|a| SocketAddr::new(a, url.port_or_known_default().unwrap_or(443)))
            .collect())
    }
    async fn inner(&self, url: &Url, accept: &str, retry: bool) -> Result<Response, Failure> {
        parse_url(url.as_str())?;
        let addresses = self.addresses(url).await?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .resolve_to_addrs(url.host_str().ok_or(Failure::Url)?, &addresses)
            .build()
            .map_err(|_| Failure::Transport)?;
        fetch(&client, url, accept, retry).await
    }
}
#[async_trait]
impl Transport for Http {
    async fn request(
        &self,
        url: &Url,
        accept: &str,
        challenge_retry: bool,
        cancellation: &Cancellation,
    ) -> Result<Response, Failure> {
        tokio::select! {biased;()=cancellation.cancelled()=>Err(Failure::Cancelled),result=self.inner(url,accept,challenge_retry)=>result,}
    }
}
async fn fetch(
    client: &reqwest::Client,
    url: &Url,
    accept: &str,
    retry: bool,
) -> Result<Response, Failure> {
    let mut response = client
        .get(url.clone())
        .header("accept", accept)
        .header("accept-language", "en-US,en;q=0.9")
        .header("user-agent", if retry { "eve" } else { USER_AGENT })
        .header("accept-encoding", "gzip, deflate, br")
        .send()
        .await
        .map_err(|_| Failure::Transport)?;
    let status = response.status().as_u16();
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned()
    };
    let content_type = header("content-type");
    let location = response
        .headers()
        .contains_key("location")
        .then(|| header("location"));
    let challenge = header("cf-mitigated") == "challenge";
    let encoding = header("content-encoding");
    // Drop redirect bodies immediately. The executor returns the destination as
    // a new explicit tool action; this client cannot forward requests to it.
    if [301, 302, 303, 307, 308].contains(&status) && location.is_some() {
        return Ok(Response {
            status,
            content_type,
            location,
            challenge,
            body: vec![],
        });
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BODY as u64)
    {
        return Err(Failure::Size);
    }
    let mut body = vec![];
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Transport)? {
        if body.len() + chunk.len() > MAX_BODY {
            return Err(Failure::Size);
        }
        body.extend_from_slice(&chunk);
    }
    let body = decode(body, &encoding)?;
    Ok(Response {
        status,
        content_type,
        location,
        challenge,
        body,
    })
}
fn decode(mut body: Vec<u8>, encoding: &str) -> Result<Vec<u8>, Failure> {
    for encoding in encoding.split(',').rev().map(str::trim) {
        if encoding.is_empty() || encoding.eq_ignore_ascii_case("identity") {
            continue;
        }
        let zlib = body.len() >= 2
            && body[0] & 15 == 8
            && u16::from_be_bytes([body[0], body[1]]).is_multiple_of(31);
        let cursor = Cursor::new(body);
        let reader: Box<dyn Read> = match encoding.to_ascii_lowercase().as_str() {
            "gzip" => Box::new(flate2::read::MultiGzDecoder::new(cursor)),
            "br" => Box::new(brotli::Decompressor::new(cursor, 8192)),
            "deflate" if zlib => Box::new(flate2::read::ZlibDecoder::new(cursor)),
            "deflate" => Box::new(flate2::read::DeflateDecoder::new(cursor)),
            _ => return Err(Failure::Transport),
        };
        let mut decoded = vec![];
        reader
            .take((MAX_BODY + 1) as u64)
            .read_to_end(&mut decoded)
            .map_err(|_| Failure::Transport)?;
        if decoded.len() > MAX_BODY {
            return Err(Failure::Size);
        }
        body = decoded;
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, Bytes},
        http::{HeaderMap, Response as HttpResponse},
        routing::get,
    };
    use std::{
        io::Write,
        sync::{
            Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };
    struct Answers(Vec<IpAddr>, AtomicUsize);
    #[async_trait]
    impl Resolver for Answers {
        async fn lookup(&self, _: &str) -> Result<Vec<IpAddr>, Failure> {
            self.1.fetch_add(1, Ordering::SeqCst);
            Ok(self.0.clone())
        }
    }
    #[tokio::test]
    async fn every_dns_answer_is_checked_before_building_a_pinned_connection() {
        for answers in [
            vec!["8.8.8.8", "10.0.0.1"],
            vec!["2606:4700:4700::1111", "::ffff:127.0.0.1"],
            vec!["127.0.0.1"],
        ] {
            let resolver = Arc::new(Answers(
                answers.into_iter().map(|v| v.parse().unwrap()).collect(),
                AtomicUsize::new(0),
            ));
            let http = Http {
                resolver: resolver.clone(),
            };
            assert!(matches!(
                http.addresses(&Url::parse("https://public.example").unwrap())
                    .await,
                Err(Failure::Private)
            ));
            assert_eq!(resolver.1.load(Ordering::SeqCst), 1);
        }
        let resolver = Arc::new(Answers(
            vec![
                "8.8.8.8".parse().unwrap(),
                "2606:4700:4700::1111".parse().unwrap(),
            ],
            AtomicUsize::new(0),
        ));
        let http = Http {
            resolver: resolver.clone(),
        };
        let addresses = http
            .addresses(&Url::parse("https://public.example:8443").unwrap())
            .await
            .unwrap();
        assert_eq!(addresses.len(), 2);
        assert!(addresses.iter().all(|a| a.port() == 8443));
        for target in [
            "https://localhost",
            "https://foo.localhost.",
            "https://127.1",
            "https://[::1]",
        ] {
            assert!(http.addresses(&Url::parse(target).unwrap()).await.is_err());
        }
        assert_eq!(resolver.1.load(Ordering::SeqCst), 1);
    }
    struct Server {
        url: Url,
        client: reqwest::Client,
        seen: Arc<Mutex<Vec<HeaderMap>>>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl Server {
        async fn new(body: Vec<u8>, encoding: &str, redirect: bool, chunked: bool) -> Self {
            let seen = Arc::new(Mutex::new(vec![]));
            let captured = seen.clone();
            let encoding = encoding.to_owned();
            let app = Router::new().route(
                "/",
                get(move |headers: HeaderMap| {
                    let body = body.clone();
                    let seen = captured.clone();
                    let encoding = encoding.clone();
                    async move {
                        seen.lock().unwrap().push(headers);
                        let response = HttpResponse::builder()
                            .header("content-type", "text/plain")
                            .header("content-encoding", encoding);
                        if redirect {
                            return response
                                .status(302)
                                .header("location", "https://127.0.0.1/forbidden")
                                .body(Body::from_stream(futures_util::stream::pending::<
                                    Result<Bytes, std::io::Error>,
                                >()))
                                .unwrap();
                        }
                        let body = if chunked {
                            Body::from_stream(futures_util::stream::iter(
                                body.chunks(1024 * 1024)
                                    .map(|v| Ok::<_, std::io::Error>(Bytes::copy_from_slice(v)))
                                    .collect::<Vec<_>>(),
                            ))
                        } else {
                            Body::from(body)
                        };
                        response.body(body).unwrap()
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let url = Url::parse(&format!("http://web-fixture.test:{}/", address.port())).unwrap();
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .resolve("web-fixture.test", address)
                .build()
                .unwrap();
            let task = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            Self {
                url,
                client,
                seen,
                task,
            }
        }
    }
    fn encoded(data: &[u8], kind: &str) -> Vec<u8> {
        match kind {
            "gzip" => {
                let mut e = flate2::write::GzEncoder::new(vec![], flate2::Compression::default());
                e.write_all(data).unwrap();
                e.finish().unwrap()
            }
            "deflate" => {
                let mut e = flate2::write::ZlibEncoder::new(vec![], flate2::Compression::default());
                e.write_all(data).unwrap();
                e.finish().unwrap()
            }
            "br" => {
                let mut output = vec![];
                {
                    let mut e = brotli::CompressorWriter::new(&mut output, 4096, 3, 22);
                    e.write_all(data).unwrap();
                }
                output
            }
            _ => data.to_vec(),
        }
    }
    #[tokio::test]
    async fn http_reads_are_bounded_decode_compression_and_send_only_public_headers() {
        for encoding in ["identity", "gzip", "deflate", "br"] {
            let fixture = Server::new(
                encoded("Hello 😀".as_bytes(), encoding),
                encoding,
                false,
                false,
            )
            .await;
            let response = fetch(&fixture.client, &fixture.url, "text/plain", false)
                .await
                .unwrap();
            assert_eq!(response.body, "Hello 😀".as_bytes());
            fetch(&fixture.client, &fixture.url, "text/plain", true)
                .await
                .unwrap();
            let seen = fixture.seen.lock().unwrap();
            assert_eq!(seen.len(), 2);
            assert_eq!(seen[0]["accept"], "text/plain");
            assert_eq!(seen[0]["accept-language"], "en-US,en;q=0.9");
            assert_eq!(seen[0]["user-agent"], USER_AGENT);
            assert_eq!(seen[1]["user-agent"], "eve");
            for h in seen.iter() {
                for name in [
                    "authorization",
                    "cookie",
                    "x-forge-agent-run-id",
                    "x-vercel-trusted-oidc-idp-token",
                ] {
                    assert!(!h.contains_key(name));
                }
            }
        }
        for (body, encoding, chunked) in [
            (vec![b'x'; MAX_BODY + 1], "identity", false),
            (vec![b'x'; MAX_BODY + 1], "identity", true),
            (encoded(&vec![b'x'; MAX_BODY + 1], "gzip"), "gzip", false),
        ] {
            let fixture = Server::new(body, encoding, false, chunked).await;
            assert!(matches!(
                fetch(&fixture.client, &fixture.url, "text/plain", false).await,
                Err(Failure::Size)
            ));
        }
        let fixture = Server::new(vec![], "identity", true, false).await;
        let response = tokio::time::timeout(
            Duration::from_secs(2),
            fetch(&fixture.client, &fixture.url, "text/plain", false),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response.status, 302);
        assert!(response.body.is_empty());
        assert_eq!(fixture.seen.lock().unwrap().len(), 1);
    }
}
