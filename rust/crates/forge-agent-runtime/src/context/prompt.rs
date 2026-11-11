use super::{estimate, utf16_len, utf16_prefix};
use forge_core::{canonical::javascript_stringify, text::trim};
use serde_json::{Value, json};

pub const SYSTEM: &str = "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\nInclude:\n\n- Current progress and key decisions made\n- Important context, constraints, or user preferences\n- What remains to be done, with clear next steps\n- Any critical data, examples, or references needed to continue\n\nBe concise, structured, and focused on helping the next LLM seamlessly continue the work. Write in the same language as the conversation. Do not continue the conversation, answer its questions, or invent facts. Only output the handoff summary.";
#[derive(Clone, Debug, PartialEq)]
pub struct Prompt {
    pub system: &'static str,
    pub prompt: String,
}
impl Prompt {
    pub fn messages(&self) -> Vec<Value> {
        vec![
            json!({"role":"system","content":self.system}),
            json!({"role":"user","content":self.prompt}),
        ]
    }
}
pub fn envelope(previous: &str, transcript: &str) -> String {
    format!(
        "<previous-checkpoint>\n{previous}\n</previous-checkpoint>\n\n<conversation>\nConversation transcript:\n{transcript}\n</conversation>\n\nUpdate the previous checkpoint with the newer information in the conversation. If there is no previous checkpoint, create one from the conversation.\n\nMake completed work explicit so the next model does not repeat it. Keep completed work separate from current and remaining work, and do not describe completed work as pending unless later messages show it must be redone. Preserve exact file paths, function names, commands, error messages, identifiers, and measured values when they are needed to continue.\n\nLarge tool outputs are the main thing to compress: reduce each to the findings the next model needs — what was searched or read, what it established, and the exact identifiers involved — rather than reproducing the output. The next model cannot see the originals, so nothing it would need to act on may be lost."
    )
}
pub fn create(messages: &[Value], previous: Option<&str>, budget: Option<f64>) -> Prompt {
    let previous = previous.map(trim).unwrap_or("(none)");
    let mut contents = messages
        .iter()
        .map(|m| render(m, false))
        .collect::<Vec<_>>();
    if let Some(budget) = budget {
        let mut excess =
            estimate(&json!(envelope(previous, &transcript(messages, &contents)))) - budget;
        for (message, content) in messages.iter().zip(&mut contents) {
            if excess <= 0. {
                break;
            }
            let reduced = render(message, true);
            if utf16_len(&reduced) < utf16_len(content) {
                excess -= (utf16_len(content) - utf16_len(&reduced)) as f64 / 4.;
                *content = reduced;
            }
        }
    }
    Prompt {
        system: SYSTEM,
        prompt: envelope(previous, &transcript(messages, &contents)),
    }
}
fn transcript(messages: &[Value], contents: &[String]) -> String {
    let parts = messages
        .iter()
        .zip(contents)
        .filter(|(_, content)| !trim(content).is_empty())
        .map(|(m, content)| {
            format!(
                "### {}\n{}",
                m["role"].as_str().unwrap_or(""),
                trim(content)
            )
        })
        .collect::<Vec<_>>();
    if parts.is_empty() {
        "(empty)".into()
    } else {
        parts.join("\n\n")
    }
}
fn render(message: &Value, reduced: bool) -> String {
    if let Some(text) = message["content"].as_str() {
        return conversation_text(text, reduced);
    }
    let parts = message["content"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    trim(
        &parts
            .iter()
            .map(|p| part(p, reduced))
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .to_owned()
}
fn conversation_text(text: &str, reduced: bool) -> String {
    if reduced {
        cap(text, 2000)
    } else {
        trim(text).into()
    }
}
fn part(part: &Value, reduced: bool) -> String {
    let limit = if reduced { 280 } else { 2000 };
    let name = part["toolName"].as_str().unwrap_or("");
    match part["type"].as_str() {
        Some("text") => conversation_text(part["text"].as_str().unwrap_or(""), reduced),
        Some("file") => file_stub(part),
        Some("tool-call") => {
            let payload = payload(part.get("input"), limit);
            if payload.is_empty() {
                format!("Called {name}")
            } else {
                format!("Called {name} with {payload}")
            }
        }
        Some("tool-result") => {
            let disposition = if part["isError"] == true {
                "errored"
            } else {
                "returned"
            };
            let output = output(part.get("output"), limit);
            if output.is_empty() {
                format!("Tool {name} {disposition}")
            } else {
                format!("Tool {name} {disposition} {output}")
            }
        }
        _ => String::new(),
    }
}
fn payload(value: Option<&Value>, limit: usize) -> String {
    value
        .map(|v| cap(&javascript_stringify(v), limit))
        .unwrap_or_default()
}
fn output(value: Option<&Value>, limit: usize) -> String {
    let Some(value) = value else {
        return String::new();
    };
    if value["type"] != "content" || !value["value"].is_array() {
        return payload(Some(value), limit);
    }
    cap(
        &value["value"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| match v["type"].as_str() {
                Some("text") if v["text"].is_string() => v["text"].as_str().unwrap().to_owned(),
                Some("file" | "media") => file_stub(v),
                _ => payload(Some(v), limit),
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" "),
        limit,
    )
}
fn file_stub(part: &Value) -> String {
    format!(
        "Attached file {} ({})",
        part["filename"].as_str().unwrap_or("attachment"),
        part["mediaType"].as_str().unwrap_or("unknown")
    )
}
pub(super) fn stub_files(output: &Value) -> Value {
    if output["type"] != "content" || !output["value"].is_array() {
        return output.clone();
    }
    let mut changed = false;
    let parts = output["value"]
        .as_array()
        .unwrap()
        .iter()
        .map(|part| {
            if matches!(part["type"].as_str(), Some("file" | "media")) {
                changed = true;
                json!({"text":file_stub(part),"type":"text"})
            } else {
                part.clone()
            }
        })
        .collect::<Vec<_>>();
    if changed {
        json!({"type":"content","value":parts})
    } else {
        output.clone()
    }
}
fn cap(text: &str, limit: usize) -> String {
    // ECMAScript \s includes BOM, but excludes Unicode NEXT LINE.
    let collapsed = text
        .split(|c: char| trim(c.encode_utf8(&mut [0; 4])).is_empty())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if utf16_len(&collapsed) <= limit {
        collapsed
    } else {
        format!("{}…", trim(&utf16_prefix(&collapsed, limit)))
    }
}
