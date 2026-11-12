//! Existing call inputs and transcript normalization. Provider I/O stays outside
//! this module; transcript contents remain untrusted product data.
use crate::{contract::*, text as js};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::LazyLock};

pub const PROVIDERS: [&str; 3] = ["google", "teams", "zoom"];
pub const PREFIXES: [&str; 3] = ["GOOGLE_MEET", "MICROSOFT_TEAMS", "ZOOM"];
pub fn selected_providers(env: &HashMap<String, String>) -> Vec<String> {
    if env.get("FORGE_CALLS_ENABLED").is_some_and(|s| s == "false") {
        return vec![];
    }
    if let Some(value) = env.get("FORGE_CALLS_PROVIDERS") {
        return value
            .split(',')
            .map(js::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
    }
    PROVIDERS
        .into_iter()
        .zip(PREFIXES)
        .filter(|(_, prefix)| {
            ["CLIENT_ID", "CLIENT_SECRET"].iter().any(|key| {
                env.get(&format!("FORGE_{prefix}_{key}"))
                    .is_some_and(|s| !s.is_empty())
            })
        })
        .map(|(provider, _)| provider.into())
        .collect()
}
pub fn configured_providers(env: &HashMap<String, String>) -> Vec<String> {
    let selected = selected_providers(env);
    PROVIDERS
        .into_iter()
        .zip(PREFIXES)
        .filter(|(provider, prefix)| {
            selected.iter().any(|s| s == provider)
                && [
                    format!("FORGE_{prefix}_CLIENT_ID"),
                    format!("FORGE_{prefix}_CLIENT_SECRET"),
                    "FORGE_MODEL_CREDENTIAL_KEK".into(),
                    "BETTER_AUTH_URL".into(),
                ]
                .iter()
                .all(|key| env.get(key).is_some_and(|s| !s.is_empty()))
        })
        .map(|(provider, _)| provider.into())
        .collect()
}
pub fn input(kind: &str, value: Value) -> Result<Value> {
    let keys: &[&str] = match kind {
        "provider" => return enumeration(value, &PROVIDERS),
        "entry" => &["speaker", "seconds", "text"],
        "recap" => &["summary", "decisions", "actions"],
        "read" => &["callId"],
        "list" => &["teamId"],
        "import" => &["teamId", "title", "startedAt", "text", "consentConfirmed"],
        "connect" => &["provider", "teamId", "consentConfirmed"],
        "note" => &["callId", "body", "kind"],
        "action" => &["callId", "actionId", "completed"],
        "retention" => &["days"],
        "disconnect" => &["id"],
        _ => return Err(ContractError("call operation")),
    };
    let mut object = Object::new(value, keys, false)?;
    for key in keys {
        if kind == "list" {
            object.optional(key, uuid)?;
            continue;
        }
        object.required(key, |v| match *key {
            "callId" | "teamId" | "actionId" | "id" => uuid(v),
            "provider" => enumeration(v, &PROVIDERS),
            "consentConfirmed" => {
                if v == true {
                    Ok(v)
                } else {
                    Err(ContractError("participant notice"))
                }
            }
            "title" => text(v, 1, 240, true),
            "startedAt" => datetime(v),
            "body" => text(v, 1, 10000, true),
            "kind" => enumeration(v, &["note", "follow-up"]),
            "completed" => boolean(v),
            "days" => {
                if [7, 30, 90, 365]
                    .iter()
                    .any(|n| v.as_f64() == Some(f64::from(*n)))
                {
                    Ok(v)
                } else {
                    Err(ContractError("retention days"))
                }
            }
            "speaker" => text(v, 0, 200, false),
            "seconds" => number(v, 0., f64::MAX, false),
            "text" => {
                if kind == "entry" {
                    text(v, 0, 20000, false)
                } else {
                    text(v, 1, 250000, true)
                }
            }
            "summary" => text(v, 0, 8000, false),
            "decisions" => list(v, 0, 50, |v| text(v, 0, 2000, false)),
            "actions" => list(v, 0, 50, |v| {
                let mut action = Object::new(v, &["title", "owner"], false)?;
                action.required("title", |v| text(v, 1, 240, false))?;
                action.required("owner", |v| text(v, 0, 200, false))?;
                Ok(action.finish())
            }),
            _ => Err(ContractError("call field")),
        })?;
    }
    Ok(object.finish())
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TranscriptEntry {
    pub speaker: String,
    pub seconds: f64,
    pub text: String,
}
struct Patterns {
    blocks: regress::Regex,
    stamp: regress::Regex,
    voice: regress::Regex,
    tags: regress::Regex,
    named: regress::Regex,
    line_named: regress::Regex,
    header: regress::Regex,
}
static PATTERNS: LazyLock<Patterns> = LazyLock::new(|| {
    let re = |s| regress::Regex::new(s).expect("source transcript expression");
    Patterns {
        blocks: re(r"\n\s*\n"),
        stamp: re(r"(?:(\d+):)?(\d{2}):(\d{2})[.,](\d+)"),
        voice: re(r"^<v\s+([^>]+)>([\s\S]*)"),
        tags: re(r"<[^>]*>"),
        named: re(r"^([^:]{1,100}):\s+([\s\S]+)"),
        line_named: re(r"^([^:]{1,100}):\s+(.+)"),
        header: re(r"^WEBVTT(?:\s|$)"),
    }
});
fn captures(re: &regress::Regex, s: &str) -> Option<Vec<Option<String>>> {
    let units: Vec<_> = s.encode_utf16().collect();
    re.find_from_ucs2(&units, 0).next().map(|m| {
        m.captures
            .iter()
            .map(|r| r.clone().map(|r| String::from_utf16_lossy(&units[r])))
            .collect()
    })
}
fn segments(re: &regress::Regex, s: &str) -> Vec<String> {
    let units: Vec<_> = s.encode_utf16().collect();
    let mut start = 0;
    let mut segments = vec![];
    for m in re.find_from_ucs2(&units, 0) {
        segments.push(String::from_utf16_lossy(&units[start..m.start()]));
        start = m.end();
    }
    segments.push(String::from_utf16_lossy(&units[start..]));
    segments
}
pub fn parse_transcript(raw: &str) -> Vec<TranscriptEntry> {
    let text = raw.replace('\r', "");
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let mut entries = vec![];
    for block in segments(&PATTERNS.blocks, text) {
        let lines: Vec<_> = block.split('\n').collect();
        let Some(time) = lines.iter().position(|line| line.contains("-->")) else {
            continue;
        };
        let Some(stamp) = captures(&PATTERNS.stamp, lines[time]) else {
            continue;
        };
        let body = lines[time + 1..].join(" ");
        let body = js::trim(&body);
        let voice = captures(&PATTERNS.voice, body);
        let raw = voice.as_ref().and_then(|v| v[1].as_deref()).unwrap_or(body);
        let plain = segments(&PATTERNS.tags, raw)
            .join("")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">");
        let named = if voice.is_none() {
            captures(&PATTERNS.named, &plain)
        } else {
            None
        };
        let speaker = voice
            .as_ref()
            .or(named.as_ref())
            .and_then(|m| m[0].as_deref())
            .unwrap_or("Speaker");
        let value = |i: usize| {
            stamp[i]
                .as_deref()
                .unwrap_or("0")
                .parse::<f64>()
                .unwrap_or(f64::INFINITY)
        };
        entries.push(TranscriptEntry {
            speaker: speaker.into(),
            seconds: value(0) * 3600. + value(1) * 60. + value(2),
            text: named.as_ref().and_then(|m| m[1].clone()).unwrap_or(plain),
        });
    }
    if !entries.is_empty() {
        return entries
            .into_iter()
            .filter(|e| !js::trim(&e.text).is_empty())
            .collect();
    }
    if PATTERNS.header.find(js::trim(text)).is_some() || text.contains("-->") {
        return vec![];
    }
    text.split('\n')
        .filter(|s| !js::trim(s).is_empty())
        .map(|line| {
            let named = captures(&PATTERNS.line_named, line);
            TranscriptEntry {
                speaker: named
                    .as_ref()
                    .and_then(|m| m[0].clone())
                    .unwrap_or_else(|| "Speaker".into()),
                seconds: 0.,
                text: named
                    .as_ref()
                    .and_then(|m| m[1].clone())
                    .unwrap_or_else(|| line.into()),
            }
        })
        .collect()
}
pub fn timestamp_label(seconds: f64) -> String {
    format!(
        "{}:{:02}",
        (seconds / 60.).floor() as u64,
        (seconds % 60.).floor() as u64
    )
}
pub fn transcript_json(entries: &[TranscriptEntry]) -> Value {
    // JSON numbers are ECMAScript numbers in the reference, irrespective of the
    // integer/float distinction in serde_json's in-memory representation.
    crate::json::parse(&crate::canonical::javascript_stringify(&json!(entries)))
        .expect("transcript JSON")
}
