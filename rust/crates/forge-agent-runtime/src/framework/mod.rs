//! Sandbox framework tools. The owner must checkpoint FileState together with
//! the tool result and supply the same isolated workspace on continuation.
//! The engine advertises these tools only with an explicit persistent backend.
mod output;
mod search;
use crate::{
    Error, Result,
    sandbox::{Cancellation, FILE_LIMIT, Workspace},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc};
use tokio::sync::OnceCell;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileState {
    workspace: Option<String>,
    stamps: BTreeMap<String, Stamp>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stamp {
    bytes: usize,
    hash: String,
}
impl FileState {
    pub(crate) fn is_empty(&self) -> bool {
        self.workspace.is_none() && self.stamps.is_empty()
    }
    pub(crate) fn validate(&self, expected: Option<&str>) -> Result<()> {
        if self.workspace.is_some() && self.workspace.as_deref() != expected
            || self.workspace.is_none() && !self.stamps.is_empty()
        {
            return Err(Error(
                "The file read state belongs to a different workspace.",
            ));
        }
        self.validate_stamps()
    }
    pub fn clear(&mut self) {
        self.stamps.clear();
    }
    fn bind(&mut self, workspace: &str) -> Result<()> {
        if workspace.is_empty() || workspace.len() > 512 {
            return Err(Error("Invalid sandbox identity."));
        }
        if self.workspace.as_deref() != Some(workspace) {
            self.workspace = Some(workspace.into());
            self.clear();
        }
        self.validate_stamps()
    }
    fn validate_stamps(&self) -> Result<()> {
        if self.stamps.len() > 4096
            || self.stamps.iter().any(|(path, stamp)| {
                path.len() > 4096
                    || stamp.bytes > FILE_LIMIT
                    || stamp.hash.len() != 64
                    || !stamp.hash.bytes().all(|b| b.is_ascii_hexdigit())
            })
        {
            return Err(Error("Invalid file read state."));
        }
        Ok(())
    }
    fn stamp(&mut self, path: String, content: &str) -> Result<()> {
        if self.stamps.len() >= 4096 && !self.stamps.contains_key(&path) {
            return Err(Error("Too many files have been read in this context."));
        }
        self.stamps.insert(path, stamp(content));
        Ok(())
    }
}
fn stamp(content: &str) -> Stamp {
    Stamp {
        bytes: content.len(),
        hash: format!("{:x}", Sha256::digest(content.as_bytes())),
    }
}

pub struct Executor {
    sandbox: Arc<dyn Workspace>,
    home: OnceCell<Option<String>>,
    ripgrep: OnceCell<bool>,
}
impl Executor {
    pub fn new(sandbox: Arc<dyn Workspace>) -> Self {
        Self {
            sandbox,
            home: OnceCell::new(),
            ripgrep: OnceCell::new(),
        }
    }
    pub async fn execute(
        &self,
        name: &str,
        input: Value,
        state: &mut FileState,
        cancellation: &Cancellation,
    ) -> Result<Value> {
        let input = forge_core::agents::framework::input(name, input)
            .map_err(|_| Error("Invalid framework tool input."))?;
        if forge_core::canonical::javascript_stringify(&input).len() > 4 * 1024 * 1024 {
            return Err(Error("Framework tool input exceeds its size limit."));
        }
        if cancellation.is_cancelled() {
            return Err(Error("Tool execution cancelled."));
        }
        // Work on a copy: failed/cancelled operations never grant overwrite
        // permission. An ambiguous write must be reconciled by its owning engine.
        let mut next = state.clone();
        next.bind(self.sandbox.identity())?;
        let result = tokio::select! { biased; ()=cancellation.cancelled()=>return Err(Error("Tool execution cancelled.")), result=self.execute_inner(name, &input, &mut next)=>result? };
        if cancellation.is_cancelled() {
            return Err(Error("Tool execution cancelled."));
        }
        *state = next;
        Ok(result)
    }
    async fn execute_inner(
        &self,
        name: &str,
        input: &Value,
        state: &mut FileState,
    ) -> Result<Value> {
        if name == "bash" {
            let result = self.sandbox.run(input["command"].as_str().unwrap()).await?;
            return Ok(output::bash(result));
        }
        let raw = input[if matches!(name, "glob" | "grep") {
            "path"
        } else {
            "filePath"
        }]
        .as_str()
        .unwrap_or("/workspace");
        let path = self.path(raw).await?;
        if name == "glob" || name == "grep" {
            return self.search(name, input, &path).await;
        }
        let content = self.sandbox.read_text(&path).await?;
        if content.as_ref().is_some_and(|s| s.len() > FILE_LIMIT) {
            return Err(Error("Sandbox file exceeds the read size limit."));
        }
        if name == "read_file" {
            let content = content.ok_or(Error("File not found in the sandbox."))?;
            if content.contains('\0') {
                return Err(Error(
                    "read_file only supports text files; this file contains NUL bytes.",
                ));
            }
            let result = output::read(
                &path,
                &content,
                input["offset"].as_u64().unwrap_or(1),
                input["limit"].as_u64().unwrap_or(2000),
            )?;
            state.stamp(path, &content)?;
            return Ok(result);
        }
        let replacement = input["content"].as_str().unwrap();
        if replacement.len() > FILE_LIMIT {
            return Err(Error("Sandbox file exceeds the write size limit."));
        }
        if let Some(content) = &content {
            let previous = state.stamps.get(&path).ok_or(Error(
                "You must read the file before overwriting it. Use read_file first.",
            ))?;
            let current = stamp(content);
            if previous.bytes != current.bytes || previous.hash != current.hash {
                return Err(Error(
                    "The file has changed since it was read. Read it again before modifying it.",
                ));
            }
        }
        // Reserve the bounded stamp before any write effect, but publish it only
        // after the remote write succeeds and the caller journals its result.
        state.stamp(path.clone(), replacement)?;
        self.sandbox.write_text(&path, replacement).await?;
        Ok(json!({"existed":content.is_some(),"path":path}))
    }
    async fn path(&self, raw: &str) -> Result<String> {
        let expanded;
        let mut path = raw;
        if raw == "$HOME" || raw.starts_with("$HOME/") {
            let home = self
                .home
                .get_or_init(|| async {
                    let result = self.sandbox.run("printf '%s\\n' \"$HOME\"").await.ok()?;
                    let home = forge_core::text::trim(&result.stdout);
                    (result.exit_code == 0
                        && home.starts_with('/')
                        && !home.contains(['\0', '\n', '\r'])
                        && home.len() <= 4096)
                        .then(|| normalize(home))
                })
                .await;
            if let Some(home) = home {
                expanded = format!("{}{}", home.trim_end_matches('/'), &raw[5..]);
                path = if expanded.is_empty() { "/" } else { &expanded };
            } else if raw == "$HOME/.agents/skills" || raw.starts_with("$HOME/.agents/skills/") {
                expanded = format!("/workspace/skills{}", &raw[20..]);
                path = &expanded;
            }
        }
        if !path.starts_with('/') || path.len() > 4096 || path.contains('\0') {
            return Err(Error(
                "filePath must be an absolute sandbox path or begin with $HOME/.",
            ));
        }
        Ok(normalize(path))
    }
}
fn normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|p| *p != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push(part);
                }
            }
            _ => parts.push(part),
        }
    }
    let mut result = format!("{}{}", if absolute { "/" } else { "" }, parts.join("/"));
    if result.is_empty() {
        result = ".".into();
    }
    if trailing && result != "/" {
        result.push('/');
    }
    result
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
