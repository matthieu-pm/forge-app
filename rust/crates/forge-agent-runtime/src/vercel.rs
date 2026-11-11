//! Vercel Sandbox v2 protocol used by Forge's installed EVE SDK. Provider
//! credentials stay in this transport, outside the sandbox environment/files.
use crate::{
    Error, Result,
    callback::PeerIdentity,
    sandbox::{Execution, FILE_LIMIT, Sandbox, Workspace},
};
use async_trait::async_trait;
use flate2::{Compression, write::GzEncoder};
use reqwest::{Client, Method, Response};
use serde_json::{Value, json};
use std::{
    io::Write,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::Mutex;
use url::Url;

const FAILED: Error = Error("The isolated sandbox is unavailable.");
const OUTPUT_LIMIT: usize = 128 * 1024;
const WIRE_LIMIT: usize = 2 * 1024 * 1024;
const LINE_LIMIT: usize = 1024 * 1024;

pub struct Options {
    pub team_id: String,
    pub project_id: String,
    /// Provider-enforced lifetime, also bounds cleanup after an ambiguous create.
    pub lifetime_ms: u64,
}
pub struct Factory(Arc<Api>);
struct Api {
    endpoint: Url,
    options: Options,
    identity: Arc<dyn PeerIdentity>,
    client: Client,
}
impl Factory {
    pub fn new(options: Options, identity: Arc<dyn PeerIdentity>) -> Result<Self> {
        Self::with_endpoint(
            options,
            identity,
            Url::parse("https://vercel.com/api/").unwrap(),
        )
    }
    fn with_endpoint(
        options: Options,
        identity: Arc<dyn PeerIdentity>,
        endpoint: Url,
    ) -> Result<Self> {
        if !identifier(&options.team_id)
            || !identifier(&options.project_id)
            || !(1000..=1_800_000).contains(&options.lifetime_ms)
        {
            return Err(FAILED);
        }
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(40))
            .build()
            .map_err(|_| FAILED)?;
        Ok(Self(Arc::new(Api {
            endpoint,
            options,
            identity,
            client,
        })))
    }
    pub async fn create(&self) -> Result<Arc<VercelSandbox>> {
        let name = format!("forge-rust-{}", uuid::Uuid::new_v4());
        // Name is known before sending the request, so a dropped creation can
        // reconcile and stop the resource even if its response was never received.
        let mut pending = PendingCreation {
            api: self.0.clone(),
            name: Some(name.clone()),
        };
        let response = self
            .0
            .request(
                Method::POST,
                "v2/sandboxes",
                Some(json!({
                    "projectId":self.0.options.project_id,"name":name,"persistent":false,
                    "ports":[],"timeout":self.0.options.lifetime_ms,"image":"vercel/eve:latest",
                    "networkPolicy":{"mode":"deny-all"},"env":{}
                })),
            )
            .await?;
        let value = json_response(response).await?;
        let session_id = value["session"]["id"]
            .as_str()
            .filter(|s| identifier(s))
            .ok_or(FAILED)?
            .to_owned();
        if value["sandbox"]["name"] != name
            || !matches!(
                value["session"]["status"].as_str(),
                Some("running" | "pending")
            )
        {
            return Err(FAILED);
        }
        let sandbox = Arc::new(VercelSandbox {
            state: Arc::new(Remote {
                api: self.0.clone(),
                session_id,
                closed: AtomicBool::new(false),
                stopped: AtomicBool::new(false),
                stop_lock: Mutex::new(()),
            }),
            operations: Mutex::new(()),
        });
        pending.name = None;
        // Acknowledge the policy before any execution; never silently accept a
        // provider that ignores or cannot enforce denied network access.
        let policy = sandbox
            .state
            .api
            .request(
                Method::POST,
                &sandbox.state.path("network-policy"),
                Some(json!({"mode":"deny-all"})),
            )
            .await;
        let policy = match policy {
            Ok(r) => json_response(r).await,
            Err(e) => Err(e),
        };
        if !policy.is_ok_and(|v| {
            v["session"]["id"] == sandbox.state.session_id
                && v["session"]["networkPolicy"]["mode"] == "deny-all"
        }) {
            let _ = sandbox.shutdown().await;
            return Err(FAILED);
        }
        // Only a fixed bootstrap script runs with elevated permissions. Authored
        // code is always unprivileged, with an empty environment and no network.
        let bootstrap = sandbox.command("bash",&["-lc","set -e\nmkdir -p /workspace\ncommand -v bash >/dev/null\ncommand -v node >/dev/null"],"/",true).await;
        if !bootstrap.is_ok_and(|v| v.exit_code == 0) {
            let _ = sandbox.shutdown().await;
            return Err(FAILED);
        }
        Ok(sandbox)
    }
}
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
impl Api {
    async fn builder(&self, method: Method, path: &str) -> Result<reqwest::RequestBuilder> {
        let mut url = self.endpoint.join(path).map_err(|_| FAILED)?;
        if url.origin() != self.endpoint.origin() {
            return Err(FAILED);
        }
        url.query_pairs_mut()
            .append_pair("teamId", &self.options.team_id);
        let token = tokio::time::timeout(Duration::from_secs(5), self.identity.token())
            .await
            .map_err(|_| FAILED)?
            .map_err(|_| FAILED)?;
        Ok(self
            .client
            .request(method, url)
            .bearer_auth(token)
            .header("user-agent", "forge-rust-sandbox/0.1"))
    }
    async fn request(&self, method: Method, path: &str, body: Option<Value>) -> Result<Response> {
        let mut req = self
            .builder(method, path)
            .await?
            .header("content-type", "application/json");
        if let Some(body) = body {
            req = req.json(&body);
        }
        req.send().await.map_err(|_| FAILED)
    }
    async fn stop(&self, session: &str) -> Result<()> {
        let response = self
            .request(
                Method::POST,
                &format!("v2/sandboxes/sessions/{session}/stop"),
                None,
            )
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        let value = json_response(response).await?;
        if value["session"]["id"] != session
            || !matches!(
                value["session"]["status"].as_str(),
                Some("stopping" | "stopped" | "failed" | "aborted")
            )
        {
            return Err(FAILED);
        }
        Ok(())
    }
    async fn reconcile_creation(&self, name: &str) {
        for attempt in 0..3 {
            let path = format!("v2/sandboxes/{name}");
            let Ok(request) = self.builder(Method::GET, &path).await else {
                return;
            };
            let response = request
                .query(&[("projectId", &self.options.project_id)])
                .send()
                .await;
            if let Ok(response) = response {
                let status = response.status();
                if status.is_success() {
                    if let Ok(value) = json_response(response).await
                        && value["sandbox"]["name"] == name
                        && let Some(id) = value["session"]["id"].as_str().filter(|s| identifier(s))
                    {
                        let _ = self.stop(id).await;
                    }
                    return;
                }
                if status != reqwest::StatusCode::NOT_FOUND {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(100 * (attempt + 1))).await;
        }
    }
}
async fn json_response(mut response: Response) -> Result<Value> {
    if !response.status().is_success() {
        return Err(FAILED);
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| FAILED)? {
        if data.len() + chunk.len() > LINE_LIMIT {
            return Err(FAILED);
        }
        data.extend_from_slice(&chunk);
    }
    forge_core::json::parse(std::str::from_utf8(&data).map_err(|_| FAILED)?).map_err(|_| FAILED)
}
struct PendingCreation {
    api: Arc<Api>,
    name: Option<String>,
}
impl Drop for PendingCreation {
    fn drop(&mut self) {
        if let Some(name) = self.name.take()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let api = self.api.clone();
            runtime.spawn(async move {
                let _ =
                    tokio::time::timeout(Duration::from_secs(10), api.reconcile_creation(&name))
                        .await;
            });
        }
    }
}
struct Remote {
    api: Arc<Api>,
    session_id: String,
    closed: AtomicBool,
    stopped: AtomicBool,
    stop_lock: Mutex<()>,
}
impl Remote {
    fn path(&self, suffix: &str) -> String {
        format!("v2/sandboxes/sessions/{}/{suffix}", self.session_id)
    }
    fn active(&self) -> Result<()> {
        if self.closed.load(Ordering::SeqCst) {
            Err(FAILED)
        } else {
            Ok(())
        }
    }
    async fn stop(&self) -> Result<()> {
        self.closed.store(true, Ordering::SeqCst);
        let _lock = self.stop_lock.lock().await;
        if self.stopped.load(Ordering::SeqCst) {
            return Ok(());
        }
        tokio::time::timeout(Duration::from_secs(10), self.api.stop(&self.session_id))
            .await
            .map_err(|_| FAILED)??;
        self.stopped.store(true, Ordering::SeqCst);
        Ok(())
    }
    fn revoke(self: &Arc<Self>) {
        self.closed.store(true, Ordering::SeqCst);
        if !self.stopped.load(Ordering::SeqCst)
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let state = self.clone();
            runtime.spawn(async move {
                let _ = state.stop().await;
            });
        }
    }
}
struct CommandGuard(Option<Arc<Remote>>);
impl Drop for CommandGuard {
    fn drop(&mut self) {
        if let Some(state) = self.0.take() {
            state.revoke();
        }
    }
}
pub struct VercelSandbox {
    state: Arc<Remote>,
    operations: Mutex<()>,
}
impl VercelSandbox {
    pub async fn shutdown(&self) -> Result<()> {
        self.state.stop().await
    }
    async fn command(
        &self,
        command: &str,
        args: &[&str],
        cwd: &str,
        sudo: bool,
    ) -> Result<Execution> {
        self.state.active()?;
        let mut guard = CommandGuard(Some(self.state.clone()));
        let response=self.state.api.request(Method::POST,&self.state.path("cmd"),Some(json!({"command":command,"args":args,"cwd":cwd,"env":{},"sudo":sudo,"wait":true,"logs":true,"timeout":30000}))).await?;
        let result = command_output(response, &self.state.session_id).await?;
        guard.0 = None;
        self.state.active()?;
        Ok(result)
    }
}
impl Drop for VercelSandbox {
    fn drop(&mut self) {
        self.state.revoke();
    }
}
fn relative_path(path: &str) -> Result<String> {
    if path.is_empty()
        || path.len() > 512
        || path.starts_with('/')
        || path.ends_with('/')
        || !path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
        || path.split('/').any(|s| s == "..")
    {
        return Err(FAILED);
    }
    let parts: Vec<_> = path
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    if parts.is_empty() {
        return Err(FAILED);
    }
    Ok(parts.join("/"))
}
fn archive(path: &str, content: &str) -> Result<Vec<u8>> {
    if content.len() > 4 * 1024 * 1024 {
        return Err(FAILED);
    }
    let gzip = GzEncoder::new(Vec::new(), Compression::fast());
    let mut archive = tar::Builder::new(gzip);
    let mut header = tar::Header::new_gnu();
    header.set_size(content.len() as u64);
    header.set_mode(0o644);
    header.set_mtime(0);
    header.set_cksum();
    archive
        .append_data(&mut header, path, content.as_bytes())
        .map_err(|_| FAILED)?;
    let mut gzip = archive.into_inner().map_err(|_| FAILED)?;
    gzip.flush().map_err(|_| FAILED)?;
    gzip.finish().map_err(|_| FAILED)
}
#[async_trait]
impl Sandbox for VercelSandbox {
    async fn write(&self, path: &str, content: &str) -> Result<()> {
        let path = relative_path(path)?;
        let bytes = archive(&path, content)?;
        let _lock = self.operations.lock().await;
        self.state.active()?;
        let mut guard = CommandGuard(Some(self.state.clone()));
        let response = self
            .state
            .api
            .builder(Method::POST, &self.state.path("fs/write"))
            .await?
            .header("content-type", "application/gzip")
            .header("x-cwd", "/workspace")
            .body(bytes)
            .send()
            .await
            .map_err(|_| FAILED)?;
        json_response(response).await?;
        guard.0 = None;
        self.state.active()?;
        Ok(())
    }
    async fn run(&self, command: &str) -> Result<Execution> {
        if command.len() > 8192 {
            return Err(FAILED);
        }
        let _lock = self.operations.lock().await;
        self.command("bash", &["-lc", command], "/workspace", false)
            .await
    }
    async fn remove(&self, path: &str) -> Result<()> {
        let path = relative_path(path)?;
        let _lock = self.operations.lock().await;
        if self.state.closed.load(Ordering::SeqCst) {
            return self.shutdown().await;
        }
        let path = format!("/workspace/{path}");
        let result = self
            .command("rm", &["-r", "-f", "--", &path], "/workspace", false)
            .await?;
        if result.exit_code != 0 {
            return Err(FAILED);
        }
        Ok(())
    }
}

fn absolute_file_path(path: &str) -> Result<()> {
    if !path.starts_with('/')
        || path.len() > 4096
        || path.contains('\0')
        || path.split('/').any(|part| matches!(part, "." | ".."))
    {
        return Err(FAILED);
    }
    Ok(())
}
#[async_trait]
impl Workspace for VercelSandbox {
    fn identity(&self) -> &str {
        &self.state.session_id
    }
    async fn read_text(&self, path: &str) -> Result<Option<String>> {
        absolute_file_path(path)?;
        let _lock = self.operations.lock().await;
        // Reject devices/directories/FIFOs before the provider opens a stream.
        // Path is a positional argument, never executable shell text.
        let check = self
            .command(
                "bash",
                &[
                    "-c",
                    "if [ -e \"$1\" ]; then [ -f \"$1\" ]; else exit 44; fi",
                    "forge-read",
                    path,
                ],
                "/workspace",
                false,
            )
            .await?;
        if check.exit_code == 44 {
            return Ok(None);
        }
        if check.exit_code != 0 {
            return Err(Error("Only regular sandbox files can be read."));
        }
        let mut guard = CommandGuard(Some(self.state.clone()));
        let mut response = self
            .state
            .api
            .request(
                Method::POST,
                &self.state.path("fs/read"),
                Some(json!({"path":path,"cwd":"/workspace"})),
            )
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            guard.0 = None;
            return Ok(None);
        }
        if !response.status().is_success()
            || response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_none_or(|v| v.split(';').next() != Some("application/octet-stream"))
        {
            return Err(FAILED);
        }
        if response
            .content_length()
            .is_some_and(|n| n > FILE_LIMIT as u64)
        {
            return Err(Error("Sandbox file exceeds the read size limit."));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| FAILED)? {
            if bytes.len() + chunk.len() > FILE_LIMIT {
                return Err(Error("Sandbox file exceeds the read size limit."));
            }
            bytes.extend_from_slice(&chunk);
        }
        guard.0 = None;
        self.state.active()?;
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }
    async fn write_text(&self, path: &str, content: &str) -> Result<()> {
        absolute_file_path(path)?;
        if path.ends_with('/') || content.len() > FILE_LIMIT {
            return Err(FAILED);
        }
        let bytes = archive(path.trim_start_matches('/'), content)?;
        let _lock = self.operations.lock().await;
        self.state.active()?;
        let mut guard = CommandGuard(Some(self.state.clone()));
        let response = self
            .state
            .api
            .builder(Method::POST, &self.state.path("fs/write"))
            .await?
            .header("content-type", "application/gzip")
            .header("x-cwd", "/")
            .body(bytes)
            .send()
            .await
            .map_err(|_| FAILED)?;
        json_response(response).await?;
        guard.0 = None;
        self.state.active()?;
        Ok(())
    }
}

#[derive(Default)]
struct Output {
    id: Option<String>,
    stdout: String,
    stderr: String,
    exit: Option<i32>,
}
impl Output {
    fn line(&mut self, line: &[u8], session: &str) -> Result<()> {
        if line.iter().all(u8::is_ascii_whitespace) {
            return Ok(());
        }
        let value = forge_core::json::parse(std::str::from_utf8(line).map_err(|_| FAILED)?)
            .map_err(|_| FAILED)?;
        if let Some(command) = value.get("command") {
            let id = command["id"]
                .as_str()
                .filter(|s| identifier(s))
                .ok_or(FAILED)?;
            if command["sessionId"] != session {
                return Err(FAILED);
            }
            if let Some(previous) = &self.id {
                if previous != id {
                    return Err(FAILED);
                }
                self.exit = Some(
                    command["exitCode"]
                        .as_i64()
                        .and_then(|n| i32::try_from(n).ok())
                        .ok_or(FAILED)?,
                );
            } else {
                self.id = Some(id.into());
            }
        } else {
            if self.id.is_none() {
                return Err(FAILED);
            }
            let data = value["data"].as_str().ok_or(FAILED)?;
            if self.stdout.len() + self.stderr.len() + data.len() > OUTPUT_LIMIT {
                return Err(Error("Sandbox output exceeds the inline size limit."));
            }
            match value["stream"].as_str() {
                Some("stdout") => self.stdout.push_str(data),
                Some("stderr") => self.stderr.push_str(data),
                _ => return Err(FAILED),
            }
        }
        Ok(())
    }
}
async fn command_output(mut response: Response, session: &str) -> Result<Execution> {
    if !response.status().is_success()
        || response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_none_or(|s| s.split(';').next() != Some("application/x-ndjson"))
    {
        return Err(FAILED);
    }
    let mut output = Output::default();
    let mut pending = Vec::new();
    let mut wire = 0;
    while let Some(chunk) = response.chunk().await.map_err(|_| FAILED)? {
        wire += chunk.len();
        if wire > WIRE_LIMIT {
            return Err(FAILED);
        }
        pending.extend_from_slice(&chunk);
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            if end > LINE_LIMIT {
                return Err(FAILED);
            }
            output.line(&pending[..end], session)?;
            pending.drain(..=end);
            if let Some(exit_code) = output.exit {
                return Ok(Execution {
                    stdout: output.stdout,
                    stderr: output.stderr,
                    exit_code,
                });
            }
        }
        if pending.len() > LINE_LIMIT {
            return Err(FAILED);
        }
    }
    if !pending.is_empty() {
        output.line(&pending, session)?;
    }
    Ok(Execution {
        stdout: output.stdout,
        stderr: output.stderr,
        exit_code: output.exit.ok_or(FAILED)?,
    })
}

#[cfg(test)]
mod tests;
