//! Ordinary EVE questions retain their typed answers and source request IDs.
//! These helpers do not authorize tools or resolve required approval batches.
use crate::contract::{self as c, Result};
use regex::Regex;
use serde_json::{Value, json};
use std::sync::LazyLock;

static DESCRIPTORS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../data/input-tools.json"))
        .expect("source question tool definitions")
});
static DECIMAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?$")
        .expect("JavaScript numeric option index")
});

pub fn descriptors() -> &'static [Value] {
    &DESCRIPTORS
}

/// Validate ask_question arguments. The source schema adds no defaults.
pub fn input(value: Value) -> Result<Value> {
    let mut object = c::Object::new(value, &["allowFreeform", "options", "prompt"], true)?;
    object.required("prompt", c::string)?;
    object.optional("allowFreeform", c::boolean)?;
    object.optional("options", |value| c::list(value, 0, usize::MAX, option))?;
    Ok(object.finish())
}

fn option(value: Value) -> Result<Value> {
    let mut object = c::Object::new(value, &["description", "id", "label", "style"], true)?;
    object.required("id", c::string)?;
    object.required("label", c::string)?;
    object.optional("description", c::string)?;
    object.optional("style", |value| {
        c::enumeration(value, &["primary", "danger", "default"])
    })?;
    Ok(object.finish())
}

/// Validate a typed response before binding its request ID to a pending call.
pub fn response(value: Value) -> Result<Value> {
    let mut object = c::Object::new(value, &["optionId", "requestId", "text"], true)?;
    object.required("requestId", c::string)?;
    object.optional("optionId", c::string)?;
    object.optional("text", c::string)?;
    Ok(object.finish())
}

pub fn output(value: Value) -> Result<Value> {
    let mut object = c::Object::new(value, &["optionId", "status", "text"], true)?;
    object.required("status", |value| {
        c::enumeration(value, &["answered", "ignored"])
    })?;
    object.optional("optionId", c::string)?;
    object.optional("text", c::string)?;
    Ok(object.finish())
}

/// Construct a request from validated arguments, as EVE's question extraction
/// does. Presence of options selects the list display, even for an empty list.
pub fn question(call_id: &str, input: &Value) -> Value {
    let mut request = json!({
        "action":{"callId":call_id,"input":input,"kind":"tool-call","toolName":"ask_question"},
        "display":if input.get("options").is_some() {"select"} else {"text"},
        "kind":"question","prompt":input["prompt"],"requestId":call_id,
    });
    for key in ["allowFreeform", "options"] {
        if let Some(value) = input.get(key) {
            request[key] = value.clone();
        }
    }
    request
}

/// Resolve one composer message independently against every validated request.
/// Matching favors option IDs, then labels, then one-based JavaScript numbers.
pub fn resolve_text(text: &str, requests: &[Value]) -> Vec<Value> {
    let text = crate::text::trim(text);
    if text.is_empty() {
        return vec![];
    }
    let lower = text.to_lowercase();
    requests
        .iter()
        .filter_map(|request| {
            let options = request.get("options").and_then(Value::as_array);
            if let Some(options) = options.filter(|options| !options.is_empty()) {
                let matched = options
                    .iter()
                    .find(|option| {
                        option["id"]
                            .as_str()
                            .is_some_and(|id| id.to_lowercase() == lower)
                    })
                    .or_else(|| {
                        options.iter().find(|option| {
                            option["label"]
                                .as_str()
                                .is_some_and(|label| label.to_lowercase() == lower)
                        })
                    })
                    .or_else(|| {
                        numeric_index(&lower, options.len()).and_then(|index| options.get(index))
                    });
                if let Some(option) = matched {
                    return Some(json!({"requestId":request["requestId"],"optionId":option["id"]}));
                }
            }
            if request["allowFreeform"] == true || options.is_none_or(Vec::is_empty) {
                Some(json!({"requestId":request["requestId"],"text":text}))
            } else {
                None
            }
        })
        .collect()
}

/// Build only the question tool's typed value after the caller has matched the
/// response to its request. Missing optional fields stay absent, not null.
pub fn question_output(response: Option<&Value>) -> Value {
    let Some(response) = response else {
        return json!({"status":"ignored"});
    };
    let mut output = json!({"status":"answered"});
    for key in ["optionId", "text"] {
        if let Some(value) = response.get(key) {
            output[key] = value.clone();
        }
    }
    output
}

fn numeric_index(text: &str, length: usize) -> Option<usize> {
    let radix = [("0x", 16), ("0o", 8), ("0b", 2)]
        .into_iter()
        .find_map(|(prefix, radix)| text.strip_prefix(prefix).map(|digits| (digits, radix)));
    let number = if let Some((digits, radix)) = radix {
        if digits.is_empty() {
            return None;
        }
        digits.chars().try_fold(0.0, |number, digit| {
            digit
                .to_digit(radix)
                .map(|digit| number * f64::from(radix) + f64::from(digit))
        })?
    } else if DECIMAL.is_match(text) {
        text.parse::<f64>().ok()?
    } else {
        return None;
    };
    (number.is_finite() && number.fract() == 0.0 && number > 0.0 && number <= length as f64)
        .then(|| number as usize - 1)
}
