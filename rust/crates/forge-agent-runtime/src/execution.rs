use crate::{
    Error, Result,
    auth::Channel,
    callback::{Capabilities, Request},
    contracts,
    sandbox::{Cancellation, Directory, Sandbox},
};
use forge_core::canonical::javascript_stringify;
use serde_json::{Value, json};
use std::{future::Future, sync::Arc};
use tokio::time::{Duration, Instant, timeout_at};
use uuid::Uuid;

const OUTPUT_LIMIT: usize = 128 * 1024;
const CALL_MARKER: &str = "__FORGE_CALL__";
const OUTPUT_MARKER: &str = "__FORGE_OUTPUT__";
pub const RUNNER: &str = include_str!("program-runner.mjs");

#[derive(Clone, Copy)]
pub struct Features {
    pub code_mode: bool,
    pub programmatic_tools: bool,
    pub write_tools: bool,
}
impl Default for Features {
    fn default() -> Self {
        Self {
            code_mode: true,
            programmatic_tools: true,
            write_tools: true,
        }
    }
}
struct Budget<'a> {
    cancellation: &'a Cancellation,
    deadline: Instant,
}
impl<'a> Budget<'a> {
    fn new(cancellation: &'a Cancellation, ms: u64) -> Self {
        Self {
            cancellation,
            deadline: Instant::now() + Duration::from_millis(ms),
        }
    }
    fn check(&self) -> Result<()> {
        if self.cancellation.is_cancelled() {
            return Err(Error("Sandbox execution cancelled."));
        }
        if Instant::now() >= self.deadline {
            return Err(Error("Sandbox execution timed out."));
        }
        Ok(())
    }
}
async fn bounded<T>(budget: &Budget<'_>, work: impl Future<Output = Result<T>>) -> Result<T> {
    let value = tokio::select! {
        biased;
        () = budget.cancellation.cancelled() => Err(Error("Sandbox execution cancelled.")),
        result = timeout_at(budget.deadline, work) => result.map_err(|_| Error("Sandbox execution timed out."))?,
    }?;
    budget.check()?;
    Ok(value)
}
pub async fn run_code(
    sandbox: Arc<dyn Sandbox>,
    raw: Value,
    features: Features,
    cancellation: &Cancellation,
) -> Result<Value> {
    let input = contracts::run_code(raw).map_err(|_| Error("Invalid sandbox code input."))?;
    if !features.code_mode {
        return Err(Error("Agent code mode is disabled."));
    }
    let budget = Budget::new(cancellation, input["timeoutMs"].as_u64().unwrap());
    budget.check()?;
    let directory = format!("code/{}", Uuid::new_v4());
    let cleanup = Directory::new(sandbox.clone(), directory.clone());
    let result = bounded(&budget, async {
        let language = input["language"].as_str().unwrap();
        let (extension, binary) = match language {
            "typescript" => ("ts", "node --experimental-strip-types"),
            "shell" => ("sh", "sh"), _ => ("mjs", "node"),
        };
        let path = format!("{directory}/program.{extension}");
        sandbox.write(&path, input["code"].as_str().unwrap()).await?;
        for file in input["files"].as_array().unwrap() {
            budget.check()?;
            sandbox.write(&format!("{directory}/{}",file["path"].as_str().unwrap()), file["content"].as_str().unwrap()).await?;
        }
        budget.check()?;
        let execution = sandbox.run(&format!("{binary} /workspace/{path}")).await?;
        if execution.stdout.len() + execution.stderr.len() > OUTPUT_LIMIT { return Err(Error("Sandbox output exceeds the inline size limit.")); }
        Ok(json!({"language":language,"exitCode":execution.exit_code,"stdout":execution.stdout,"stderr":execution.stderr}))
    }).await;
    cleanup.finish(result).await
}
fn marker<'a>(stdout: &'a str, marker: &str) -> Option<&'a str> {
    stdout
        .split('\n')
        .find_map(|line| line.strip_prefix(marker))
        .filter(|s| !s.is_empty())
}
pub fn needs_approval(input: &Value) -> bool {
    input["capabilityManifest"]
        .as_array()
        .is_some_and(|a| a.iter().any(|v| v["id"] == "teams.update"))
}
pub async fn execute_program(
    sandbox: Arc<dyn Sandbox>,
    capabilities: &dyn Capabilities,
    channel: &Channel,
    raw: Value,
    features: Features,
    cancellation: &Cancellation,
) -> Result<Value> {
    let input = contracts::program(raw).map_err(|_| Error("Invalid program input."))?;
    if !features.code_mode || !features.programmatic_tools {
        return Err(Error("Programmatic Forge tools are disabled."));
    }
    if needs_approval(&input) && !features.write_tools {
        return Err(Error("Agent write tools are disabled."));
    }
    let manifest = input["capabilityManifest"].as_array().unwrap();
    for entry in manifest {
        if entry["version"] != "1"
            || ![
                "teams.list",
                "teams.get",
                "workspace.describe",
                "teams.update",
            ]
            .contains(&entry["id"].as_str().unwrap())
        {
            return Err(Error("Capability is not available to programs."));
        }
    }
    let budget = Budget::new(cancellation, input["timeoutMs"].as_u64().unwrap());
    budget.check()?;
    let directory = format!("programs/{}", Uuid::new_v4());
    let cleanup = Directory::new(sandbox.clone(), directory.clone());
    let result = bounded(&budget, async {
        for (name, content) in [("runner.mjs", RUNNER.to_owned()), ("program.js", input["code"].as_str().unwrap().into()), ("manifest.json",javascript_stringify(&input["capabilityManifest"]))] {
            sandbox.write(&format!("{directory}/{name}"), &content).await?;
        }
        let mut calls: Vec<Value> = vec![];
        let maximum = manifest.iter().map(|v| v["maximumCalls"].as_u64().unwrap() as usize).sum::<usize>();
        for _ in 0..=maximum {
            budget.check()?;
            sandbox.write(&format!("{directory}/state.json"), &javascript_stringify(&json!({"calls":calls}))).await?;
            let execution = sandbox.run(&format!("node /workspace/{directory}/runner.mjs /workspace/{directory}/program.js /workspace/{directory}/state.json /workspace/{directory}/manifest.json")).await?;
            budget.check()?;
            // Markers and stderr are untrusted sandbox output, including on exit 42.
            if execution.stdout.len() + execution.stderr.len() > OUTPUT_LIMIT { return Err(Error("Program output exceeds the inline size limit.")); }
            if let Some(output) = marker(&execution.stdout, OUTPUT_MARKER) {
                let parsed = forge_core::json::parse(output).map_err(|_| Error("Invalid program output."))?;
                let result = parsed.as_object().and_then(|v| v.get("result")).ok_or(Error("Invalid program output."))?;
                if javascript_stringify(result).len() > OUTPUT_LIMIT { return Err(Error("Program output exceeds the inline size limit.")); }
                for call in &mut calls { call.as_object_mut().unwrap().remove("idempotencyKey"); }
                return Ok(json!({"result":result,"calls":calls}));
            }
            let request = marker(&execution.stdout, CALL_MARKER).ok_or(Error("Program execution failed without output."))?;
            let request = contracts::call(forge_core::json::parse(request).map_err(|_| Error("Invalid program call."))?).map_err(|_| Error("Invalid program call."))?;
            if request["callIndex"].as_u64().unwrap() != calls.len() as u64 { return Err(Error("Program call order is invalid.")); }
            let declaration = manifest.iter().find(|v| v["id"] == request["capabilityId"]).ok_or(Error("Capability is not declared."))?;
            // Enforce limits in the trusted process: a program can forge stdout or
            // edit its runner/state and must not bypass the declared per-tool budget.
            if calls.len() >= maximum || calls.iter().filter(|v| v["capabilityId"] == declaration["id"]).count() >= declaration["maximumCalls"].as_u64().unwrap() as usize {
                return Err(Error("Program exceeded its declared capability call budget."));
            }
            let idempotency_key = request["idempotencyKey"].as_str().map(str::to_owned);
            if declaration["id"] == "teams.update" && idempotency_key.is_none() { return Err(Error("Program writes require an idempotency key.")); }
            budget.check()?;
            let result = capabilities.call(channel, Request { id: declaration["id"].as_str().unwrap().into(), version: declaration["version"].as_str().unwrap().into(), input: request["input"].clone(), idempotency_key }).await?;
            let mut call = json!({"capabilityId":request["capabilityId"],"input":request["input"],"result":result});
            if let Some(key) = request.get("idempotencyKey") { call["idempotencyKey"] = key.clone(); }
            calls.push(call);
            if javascript_stringify(&json!({"calls":calls})).len() > 4 * 1024 * 1024 {
                return Err(Error("Program replay state exceeds the size limit."));
            }
        }
        Err(Error("Program exceeded its declared capability call budget."))
    }).await;
    cleanup.finish(result).await
}
