//! Aggregate operational diagnostics. No prompts, tool input or provider keys
//! appear in this projection; callers enforce workspace administrator authority.
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
fn increment(value: &mut Value, key: &str) {
    value[key] = json!(value[key].as_u64().unwrap_or(0) + 1);
}
fn ratio(n: f64, d: usize) -> Value {
    let value = if d == 0 { 0. } else { n / d as f64 };
    if value.fract() == 0. {
        json!(value as i64)
    } else {
        json!(value)
    }
}
fn time(v: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(v.as_str()?)
        .ok()
        .map(|t| t.timestamp_millis())
}
fn percentiles(mut numbers: Vec<i64>) -> Value {
    numbers.sort_unstable();
    let percentile = |q: f64| {
        if numbers.is_empty() {
            Value::Null
        } else {
            json!(
                numbers[((numbers.len() as f64 * q).ceil() as usize)
                    .saturating_sub(1)
                    .min(numbers.len() - 1)]
            )
        }
    };
    json!({"p50":percentile(0.5),"p95":percentile(0.95)})
}
pub fn summarize(input: &Value, generated_at: &str) -> Value {
    let empty = Vec::new();
    let rows = |key: &str| input[key].as_array().unwrap_or(&empty);
    let mut states = json!({});
    let mut executions = json!({});
    let mut providers = json!({});
    let mut models = json!({});
    let mut efforts = json!({});
    let mut difficulties = json!({});
    let mut usage = json!({"inputTokens":0,"outputTokens":0,"cachedInputTokens":0,"costMicros":0});
    let mut durations = vec![];
    for run in rows("runs") {
        increment(&mut states, run["state"].as_str().unwrap_or(""));
        increment(&mut executions, run["executionKind"].as_str().unwrap_or(""));
        if let Some(p) = run["requestedSelection"]["provider"].as_str() {
            increment(&mut providers, p);
        }
        if let Some(m) = run["resolvedModelId"].as_str().filter(|s| !s.is_empty()) {
            increment(&mut models, m);
        }
        if let Some(e) = run["reasoningEffort"].as_str().filter(|s| !s.is_empty()) {
            increment(&mut efforts, e);
        }
        if run["requestedSelection"]["mode"] == "auto"
            && let Some(reason) = run["routingReason"]
                .as_str()
                .and_then(|s| crate::json::parse(s).ok())
            && let Some(d) = reason["difficulty"].as_str().filter(|s| !s.is_empty())
        {
            increment(&mut difficulties, d);
        }
        for key in [
            "inputTokens",
            "outputTokens",
            "cachedInputTokens",
            "costMicros",
        ] {
            usage[key] = json!(usage[key].as_i64().unwrap_or(0) + run[key].as_i64().unwrap_or(0));
        }
        if let (Some(start), Some(end)) = (time(&run["startedAt"]), time(&run["completedAt"])) {
            durations.push(end - start);
        }
    }
    let mut by_run: HashMap<&str, Vec<&Value>> = HashMap::new();
    let mut reconnected = HashSet::new();
    let (mut reconnects, mut starts, mut completions, mut failures) = (0, 0, 0, 0);
    for event in rows("events") {
        let run = event["runId"].as_str().unwrap_or("");
        by_run.entry(run).or_default().push(event);
        match event["type"].as_str() {
            Some("progress.note") if event["payload"]["state"] == "reconnecting" => {
                reconnects += 1;
                reconnected.insert(run);
            }
            Some("code.started") => starts += 1,
            Some("code.completed") => completions += 1,
            Some("tool.failed")
                if matches!(
                    event["payload"]["toolName"].as_str(),
                    Some("run_code" | "execute_program")
                ) =>
            {
                failures += 1
            }
            _ => {}
        }
    }
    let mut progress = vec![];
    let mut tokens = vec![];
    for run in rows("runs") {
        let events = by_run.get(run["id"].as_str().unwrap_or(""));
        let first = |kind: &str| {
            events
                .and_then(|es| es.iter().find(|e| e["type"] == kind))
                .and_then(|e| time(&e["occurredAt"]))
        };
        if let Some(created) = first("run.created").or_else(|| time(&run["createdAt"])) {
            if let Some(at) = first("progress.note") {
                progress.push(at - created);
            }
            if let Some(at) = first("assistant.delta") {
                tokens.push(at - created);
            }
        }
    }
    let mut approvals = json!({});
    for a in rows("approvals") {
        increment(&mut approvals, a["state"].as_str().unwrap_or(""));
    }
    let approved = approvals["approved"].as_u64().unwrap_or(0);
    let denied = approvals["denied"].as_u64().unwrap_or(0);
    let tools = rows("invocations");
    let tool_failures = tools.iter().filter(|i| i["outcome"] == "failed").count();
    json!({"since":input["since"],"generatedAt":generated_at,"runs":{"total":rows("runs").len(),"states":states,"executionKinds":executions,"durationMs":percentiles(durations),"timeToFirstProgressMs":percentiles(progress),"timeToFirstTokenMs":percentiles(tokens),"rates":{"completion":ratio(states["completed"].as_f64().unwrap_or(0.),rows("runs").len()),"cancellation":ratio(states["cancelled"].as_f64().unwrap_or(0.),rows("runs").len()),"failure":ratio(states["failed"].as_f64().unwrap_or(0.),rows("runs").len())}},"routing":{"providers":providers,"models":models,"efforts":efforts,"autoDifficulties":difficulties},"usage":usage,"approvals":{"states":approvals,"acceptanceRate":ratio(approved as f64,(approved+denied) as usize),"denialRate":ratio(denied as f64,(approved+denied) as usize)},"tools":{"calls":tools.len(),"failures":tool_failures,"failureRate":ratio(tool_failures as f64,tools.len()),"latencyMs":percentiles(tools.iter().filter_map(|i|i["durationMs"].as_i64()).collect())},"sandbox":{"starts":starts,"completions":completions,"failures":failures,"failureRate":ratio(failures as f64,starts)},"recovery":{"reconnects":reconnects,"reconnectedRuns":reconnected.len()}})
}
