use serde_json::{Value, json};
use std::sync::LazyLock;
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct RoutingError {
    pub code: &'static str,
    pub message: String,
}
fn error(code: &'static str, message: impl Into<String>) -> RoutingError {
    RoutingError {
        code,
        message: message.into(),
    }
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
const EFFORTS: &[&str] = &["max", "xhigh", "high", "medium", "low", "minimal", "none"];
const PATTERNS: &[(&str, &str)] = &[
    (
        "formatting-or-extraction",
        r"\b(format|reformat|extract|summari[sz]e|list|translate)\b",
    ),
    ("bounded-read", r"\b(find|get|show|look up|read|search)\b"),
    (
        "multi-step",
        r"\b(first|then|after that|multiple|several|across)\b",
    ),
    (
        "implementation",
        r"\b(implement|build|code|refactor|migrate|integrate)\b",
    ),
    (
        "architecture",
        r"\b(architecture|system design|design the system|trade-?offs?)\b",
    ),
    (
        "diagnosis",
        r"\b(diagnos|debug|root cause|race condition|performance regression)\b",
    ),
    (
        "broad-scope",
        r"\b(complete|entire|end-to-end|production-ready|full plan)\b",
    ),
    (
        "maximum-depth",
        r"\b(max(?:imum)? depth|deepest|xhigh|extra high|do not stop)\b",
    ),
];
fn classify(input: &Value) -> (&'static str, Vec<&'static str>) {
    static RE: LazyLock<Vec<regress::Regex>> = LazyLock::new(|| {
        PATTERNS
            .iter()
            .map(|(_, p)| regress::Regex::with_flags(p, "i").unwrap())
            .collect()
    });
    let mut signals = PATTERNS
        .iter()
        .zip(RE.iter())
        .filter(|(_, re)| re.find(text(input, "message")).is_some())
        .map(|((s, _), _)| *s)
        .collect::<Vec<_>>();
    if input["priorStrongAttemptFailed"] == true {
        signals.push("prior-strong-attempt-failed");
    }
    let difficulty = if signals
        .iter()
        .any(|s| ["maximum-depth", "prior-strong-attempt-failed"].contains(s))
    {
        "exceptional"
    } else if signals
        .iter()
        .any(|s| ["architecture", "diagnosis", "broad-scope"].contains(s))
    {
        "complex"
    } else if signals
        .iter()
        .any(|s| ["implementation", "multi-step"].contains(s))
        || text(input, "message").encode_utf16().count() > 600
    {
        "standard"
    } else {
        "simple"
    };
    (difficulty, signals)
}
fn strength(id: &str) -> f64 {
    static GPT: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"gpt-([0-9]+)(?:[.-]([0-9]+))?").unwrap());
    static O: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^o([0-9]+)").unwrap());
    let id = id.to_lowercase();
    let version = GPT.captures(&id).or_else(|| O.captures(&id));
    let number = |n| {
        version
            .as_ref()
            .and_then(|v| v.get(n))
            .and_then(|v| v.as_str().parse::<f64>().ok())
            .unwrap_or(0.)
    };
    let mut score = number(1) * 100. + number(2) * 10.;
    if id.starts_with('o') {
        score += 450.;
    }
    for (fragment, weight) in [
        ("sol", 1000.),
        ("terra", 700.),
        ("luna", 400.),
        ("mini", -120.),
        ("nano", -220.),
    ] {
        if id.contains(fragment) {
            score += weight;
        }
    }
    score
}
fn route(model: &Value, effort: &str) -> Value {
    json!({"runtimeKind":if model["executionKind"]=="forge-native"{"eve"}else if text(model,"selectionId").starts_with("local:codex:"){"codex"}else{"claude"},"executionKind":model["executionKind"],"connectionId":model["connectionId"],"connectionLabel":model["sourceLabel"],"locality":model["locality"],"billingMode":model["billingMode"],"provider":model["provider"],"providerLabel":model["providerLabel"],"modelId":model["modelId"],"modelDisplayName":model["displayName"],"reasoningEffort":effort})
}
fn supports(model: &Value, effort: &str) -> bool {
    model["supportedReasoningEfforts"]
        .as_array()
        .is_some_and(|a| a.iter().any(|v| v == effort))
}
pub fn resolve(input: &Value) -> Result<Value, RoutingError> {
    let models = input["availableModels"].as_array().ok_or_else(|| {
        error(
            "MODEL_UNAVAILABLE",
            "The selected model is no longer available through that connection.",
        )
    })?;
    if input["mode"] == "manual" {
        let reference = input
            .get("manualModel")
            .filter(|v| !v.is_null())
            .ok_or_else(|| error("MODEL_UNAVAILABLE", "Manual routing requires a model."))?;
        let model = models
            .iter()
            .find(|m| {
                m["status"] == "available"
                    && m["supportsTools"] == true
                    && ["connectionId", "modelId", "executionKind"]
                        .iter()
                        .all(|k| m[*k] == reference[*k])
            })
            .ok_or_else(|| {
                error(
                    "MODEL_UNAVAILABLE",
                    "The selected model is no longer available through that connection.",
                )
            })?;
        let effort = input["reasoningEffort"].as_str().unwrap_or("medium");
        if !supports(model, effort) {
            return Err(error(
                "EFFORT_UNSUPPORTED",
                format!(
                    "{} does not support {effort} reasoning.",
                    text(model, "displayName")
                ),
            ));
        }
        return Ok(
            json!({"requestedSelection":model["selectionId"],"model":reference,"reasoningEffort":effort,"routingPolicyVersion":null,"routingReason":null,"route":route(model,effort)}),
        );
    }
    let (difficulty, signals) = classify(input);
    let (fragment, preferred) = match difficulty {
        "simple" => ("luna", "low"),
        "standard" => ("terra", "medium"),
        "complex" => ("sol", "high"),
        _ => ("sol", "xhigh"),
    };
    let mut models = models
        .iter()
        .filter(|m| {
            text(m, "provider").to_lowercase() == "openai"
                && m["status"] == "available"
                && m["supportsTools"] == true
                && (text(input, "preferredOpenAIConnectionId").is_empty()
                    || m["connectionId"] == input["preferredOpenAIConnectionId"])
        })
        .collect::<Vec<_>>();
    let chosen = if let Some(m) = models
        .iter()
        .find(|m| text(m, "modelId").to_lowercase().contains(fragment))
    {
        Some(*m)
    } else {
        models.sort_by(|a, b| {
            let small = |v: &Value| {
                let id = text(v, "modelId").to_lowercase();
                id.contains("mini") || id.contains("nano")
            };
            let small_a = small(a);
            let small_b = small(b);
            if small_a != small_b {
                if difficulty == "simple" {
                    return small_b.cmp(&small_a);
                }
                if ["complex", "exceptional"].contains(&difficulty) {
                    return small_a.cmp(&small_b);
                }
            }
            strength(text(b, "modelId"))
                .partial_cmp(&strength(text(a, "modelId")))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        models.first().copied()
    }
    .ok_or_else(|| {
        error(
            "AUTO_UNAVAILABLE",
            "Connect OpenAI or Codex with a compatible model to use Auto.",
        )
    })?;
    let index = EFFORTS.iter().position(|e| *e == preferred).unwrap();
    let effort = EFFORTS[index..]
        .iter()
        .chain(EFFORTS.iter())
        .find(|e| supports(chosen, e))
        .ok_or_else(|| {
            error(
                "AUTO_UNAVAILABLE",
                "The available OpenAI models do not support a compatible effort level.",
            )
        })?;
    Ok(
        json!({"requestedSelection":"auto","model":{"selectionId":chosen["selectionId"],"connectionId":chosen["connectionId"],"executionKind":chosen["executionKind"],"provider":chosen["provider"],"modelId":chosen["modelId"]},"reasoningEffort":effort,"routingPolicyVersion":"openai-auto-v1","routingReason":crate::canonical::javascript_stringify(&json!({"difficulty":difficulty,"signals":signals})),"route":route(chosen,effort)}),
    )
}
