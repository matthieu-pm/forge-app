//! Model requests derived from the installed provider SDK behavior used by Forge.
//! The caller identity selects the model; conversation input cannot override it.
use crate::{Error, Result, auth::Channel};
use forge_core::canonical::javascript_stringify;
use serde_json::{Value, json};
use std::sync::LazyLock;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Protocol {
    Responses,
    Chat,
    Anthropic,
}
impl Protocol {
    pub fn for_provider(provider: &str) -> Self {
        match provider {
            "openai" => Self::Responses,
            "anthropic" | "custom-anthropic" => Self::Anthropic,
            _ => Self::Chat,
        }
    }
    pub fn path(self) -> &'static str {
        match self {
            Self::Responses => "responses",
            Self::Chat => "chat/completions",
            Self::Anthropic => "messages",
        }
    }
}
pub struct Request {
    pub protocol: Protocol,
    pub body: Value,
}
const INVALID: Error = Error("The model conversation contains unsupported or invalid content.");
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().ok_or(INVALID)
}
fn parts(v: &Value) -> Result<&Vec<Value>> {
    v["content"].as_array().ok_or(INVALID)
}
fn reasoning_model(model: &str) -> bool {
    static O: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^o(\d+)(?:-|$)").unwrap());
    static GPT: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$").unwrap());
    if O.is_match(model) {
        return true;
    }
    GPT.captures(model).is_some_and(|c| {
        c[1].parse::<f64>().is_ok_and(|n| n >= 5.)
            && !(c.get(2).is_none() && c.get(3).is_some_and(|v| v.as_str().starts_with("chat")))
    })
}
fn anthropic_max(model: &str) -> (u32, bool) {
    if [
        "claude-opus-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-fable-5",
        "claude-sonnet-5",
        "claude-sonnet-4-6",
        "claude-opus-4-6",
    ]
    .iter()
    .any(|s| model.contains(s))
    {
        (128000, true)
    } else if ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"]
        .iter()
        .any(|s| model.contains(s))
    {
        (64000, true)
    } else if model.contains("claude-opus-4-1") {
        (32000, true)
    } else if model.contains("claude-sonnet-4-") {
        (64000, true)
    } else if model.contains("claude-opus-4-") {
        (32000, true)
    } else if model.contains("claude-3-haiku") {
        (4096, true)
    } else {
        static LEGACY: LazyLock<regex::Regex> = LazyLock::new(|| {
            regex::Regex::new(r"claude-(?:instant(?:-|$)|v?2(?:$|[-.:])|3(?:$|[-.]))").unwrap()
        });
        if LEGACY.is_match(model) || !model.contains("claude-") {
            (4096, false)
        } else {
            (128000, false)
        }
    }
}
fn tool_output(part: &Value) -> Result<String> {
    let output = &part["output"];
    match string(output, "type")? {
        "text" | "error-text" => Ok(string(output, "value")?.into()),
        "json" | "error-json" | "content" => {
            Ok(javascript_stringify(output.get("value").ok_or(INVALID)?))
        }
        "execution-denied" => Ok(output["reason"]
            .as_str()
            .unwrap_or("Tool call execution denied.")
            .into()),
        _ => Err(INVALID),
    }
}
fn file(part: &Value, index: usize, protocol: Protocol) -> Result<Value> {
    // The app resolves private attachments before runtime delivery. Do not turn
    // untrusted URLs or provider references into a new retrieval authority here.
    if part["data"]["type"] != "data" {
        return Err(INVALID);
    }
    let data = string(&part["data"], "data")?;
    let mime = string(part, "mediaType")?;
    if mime.chars().any(char::is_whitespace) || !mime.contains('/') {
        return Err(INVALID);
    }
    let data_url = format!("data:{mime};base64,{data}");
    if mime.starts_with("image/") {
        return Ok(match protocol {
            Protocol::Responses => json!({"type":"input_image","image_url":data_url}),
            Protocol::Chat => json!({"type":"image_url","image_url":{"url":data_url}}),
            Protocol::Anthropic => {
                json!({"type":"image","source":{"type":"base64","media_type":mime,"data":data}})
            }
        });
    }
    if protocol == Protocol::Chat && ["audio/wav", "audio/mp3", "audio/mpeg"].contains(&mime) {
        return Ok(
            json!({"type":"input_audio","input_audio":{"data":data,"format":if mime=="audio/wav"{"wav"}else{"mp3"}}}),
        );
    }
    if mime != "application/pdf" {
        return Err(INVALID);
    }
    let name = part["filename"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("part-{index}.pdf"));
    Ok(match protocol {
        Protocol::Responses => json!({"type":"input_file","filename":name,"file_data":data_url}),
        Protocol::Chat => json!({"type":"file","file":{"filename":name,"file_data":data_url}}),
        Protocol::Anthropic => {
            let mut value =
                json!({"type":"document","source":{"type":"base64","media_type":mime,"data":data}});
            if let Some(name) = part.get("filename") {
                value["title"] = name.clone();
            }
            value
        }
    })
}
fn user_parts(content: &[Value], protocol: Protocol) -> Result<Vec<Value>> {
    content.iter().enumerate().map(|(index,part)|match string(part,"type")? {
        "text"=>Ok(json!({"type":if protocol==Protocol::Responses{"input_text"}else{"text"},"text":string(part,"text")?})),
        "file"=>file(part,index,protocol),_=>Err(INVALID),
    }).collect()
}
fn structured_tool_output(part: &Value, protocol: Protocol) -> Result<Value> {
    if part["output"]["type"] != "content" {
        return Ok(json!(tool_output(part)?));
    }
    let content = part["output"]["value"].as_array().ok_or(INVALID)?;
    let mut normalized = content.clone();
    for item in &mut normalized {
        if item["type"] == "file" {
            let object = item.as_object_mut().ok_or(INVALID)?;
            match protocol {
                Protocol::Responses => {
                    object.entry("filename").or_insert(json!("data"));
                }
                Protocol::Anthropic => {
                    object.remove("filename");
                }
                Protocol::Chat => return Err(INVALID),
            }
        }
    }
    Ok(json!(user_parts(&normalized, protocol)?))
}
fn responses(prompt: &[Value], system: &str) -> Result<Vec<Value>> {
    let mut output = vec![];
    for message in prompt {
        match string(message, "role")? {
            "system" => output.push(json!({"role":system,"content":string(message,"content")?})),
            "user" => output.push(
                json!({"role":"user","content":user_parts(parts(message)?,Protocol::Responses)?}),
            ),
            "assistant" => {
                for part in parts(message)? {
                    let kind = string(part, "type")?;
                    if let Some(id) = part["providerOptions"]["openai"]["itemId"]
                        .as_str()
                        .filter(|_| ["text", "tool-call", "reasoning"].contains(&kind))
                    {
                        output.push(json!({"type":"item_reference","id":id}));
                        continue;
                    }
                    match kind {
                    "text"=>{let mut value=json!({"role":"assistant","content":[{"type":"output_text","text":string(part,"text")?}]});if let Some(phase)=part["providerOptions"]["openai"].get("phase").filter(|v|!v.is_null()){value["phase"]=phase.clone();}output.push(value);},
                    "tool-call"=>output.push(json!({"type":"function_call","call_id":string(part,"toolCallId")?,"name":string(part,"toolName")?,"arguments":javascript_stringify(part.get("input").unwrap_or(&json!({})))})),
                    "reasoning"=>{},_=>return Err(INVALID),
                }
                }
            }
            "tool" => {
                for part in parts(message)? {
                    if part["type"] == "tool-approval-response" {
                        continue;
                    }
                    if part["type"] != "tool-result" {
                        return Err(INVALID);
                    }
                    let content = structured_tool_output(part, Protocol::Responses)?;
                    output.push(json!({"type":"function_call_output","call_id":string(part,"toolCallId")?,"output":content}));
                }
            }
            _ => return Err(INVALID),
        }
    }
    Ok(output)
}
fn chat(prompt: &[Value], system: &str) -> Result<Vec<Value>> {
    let mut output = vec![];
    for message in prompt {
        match string(message, "role")? {
            "system" => output.push(json!({"role":system,"content":string(message,"content")?})),
            "user" => {
                let content = parts(message)?;
                let value = if content.len() == 1 && content[0]["type"] == "text" {
                    json!(string(&content[0], "text")?)
                } else {
                    json!(user_parts(content, Protocol::Chat)?)
                };
                output.push(json!({"role":"user","content":value}));
            }
            "assistant" => {
                let mut text = String::new();
                let mut calls = vec![];
                for part in parts(message)? {
                    match string(part,"type")? {
                    "text"=>text.push_str(string(part,"text")?),
                    "tool-call"=>calls.push(json!({"id":string(part,"toolCallId")?,"type":"function","function":{"name":string(part,"toolName")?,"arguments":javascript_stringify(part.get("input").unwrap_or(&json!({})))}})),
                    "reasoning"=>{},_=>return Err(INVALID),
                }
                }
                let mut value = json!({"role":"assistant","content":if text.is_empty()&&!calls.is_empty(){Value::Null}else{json!(text)}});
                if !calls.is_empty() {
                    value["tool_calls"] = json!(calls);
                }
                output.push(value);
            }
            "tool" => {
                for part in parts(message)? {
                    if part["type"] == "tool-approval-response" {
                        continue;
                    }
                    if part["type"] != "tool-result" {
                        return Err(INVALID);
                    }
                    output.push(json!({"role":"tool","tool_call_id":string(part,"toolCallId")?,"content":tool_output(part)?}));
                }
            }
            _ => return Err(INVALID),
        }
    }
    Ok(output)
}
fn anthropic(prompt: &[Value]) -> Result<(Vec<Value>, Vec<Value>)> {
    let mut system = vec![];
    let mut messages: Vec<Value> = vec![];
    for (message_index, message) in prompt.iter().enumerate() {
        let role = string(message, "role")?;
        if role == "system" {
            if !messages.is_empty() {
                return Err(INVALID);
            }
            system.push(json!({"type":"text","text":string(message,"content")?}));
            continue;
        }
        let content = parts(message)?;
        let mut converted = vec![];
        match role {
            "user" => converted = user_parts(content, Protocol::Anthropic)?,
            "assistant" => {
                for (index, part) in content.iter().enumerate() {
                    match string(part,"type")? {
                "text"=>{let text=string(part,"text")?;let text=if message_index+1==prompt.len()&&index+1==content.len(){forge_core::text::trim(text)}else{text};converted.push(json!({"type":"text","text":text}));},
                "tool-call"=>converted.push(json!({"type":"tool_use","id":string(part,"toolCallId")?,"name":string(part,"toolName")?,"input":part.get("input").ok_or(INVALID)?})),
                "reasoning"=>{
                    let metadata=&part["providerOptions"]["anthropic"];
                    if let Some(signature)=metadata["signature"].as_str(){converted.push(json!({"type":"thinking","thinking":string(part,"text")?,"signature":signature}));}
                    else if let Some(data)=metadata["redactedData"].as_str(){converted.push(json!({"type":"redacted_thinking","data":data}));}
                },_=>return Err(INVALID),
            }
                }
            }
            "tool" => {
                for part in content {
                    if part["type"] == "tool-approval-response" {
                        continue;
                    }
                    if part["type"] != "tool-result" {
                        return Err(INVALID);
                    }
                    let content = structured_tool_output(part, Protocol::Anthropic)?;
                    let mut value = json!({"type":"tool_result","tool_use_id":string(part,"toolCallId")?,"content":content});
                    if part["output"]["type"] == "error-text"
                        || part["output"]["type"] == "error-json"
                    {
                        value["is_error"] = json!(true);
                    }
                    converted.push(value);
                }
            }
            _ => return Err(INVALID),
        }
        let role = if role == "tool" { "user" } else { role };
        if let Some(previous) = messages.last_mut().filter(|v| v["role"] == role) {
            previous["content"]
                .as_array_mut()
                .unwrap()
                .extend(converted);
        } else {
            messages.push(json!({"role":role,"content":converted}));
        }
    }
    Ok((system, messages))
}
pub fn build(
    channel: &Channel,
    prompt: &[Value],
    tools: &[Value],
    max_output_tokens: Option<u32>,
) -> Result<Request> {
    if prompt.is_empty()
        || prompt.len() > 10000
        || tools.len() > 128
        || max_output_tokens == Some(0)
    {
        return Err(INVALID);
    }
    let protocol = Protocol::for_provider(channel.provider());
    let model = channel.model_id();
    let reasoning = reasoning_model(model);
    let system = if reasoning { "developer" } else { "system" };
    let mut body = json!({"model":model});
    match protocol {
        Protocol::Responses => {
            body["input"] = json!(responses(prompt, system)?);
            if let Some(max) = max_output_tokens {
                body["max_output_tokens"] = json!(max);
            }
        }
        Protocol::Chat => {
            body["messages"] = json!(chat(prompt, system)?);
            if let Some(max) = max_output_tokens {
                body[if reasoning {
                    "max_completion_tokens"
                } else {
                    "max_tokens"
                }] = json!(max);
            }
            body["stream_options"] = json!({"include_usage":true});
        }
        Protocol::Anthropic => {
            let (system, messages) = anthropic(prompt)?;
            if !system.is_empty() {
                body["system"] = json!(system);
            }
            body["messages"] = json!(messages);
            let (max, known) = anthropic_max(model);
            body["max_tokens"] =
                json!(max_output_tokens.map_or(max, |n| if known { n.min(max) } else { n }));
        }
    }
    if !tools.is_empty() {
        let definitions=tools.iter().map(|tool|{
            if tool["type"]!="function"||!tool["inputSchema"].is_object(){return Err(INVALID);}
            let name=string(tool,"name")?;if name.is_empty(){return Err(INVALID);}
            let mut value=match protocol{
                Protocol::Responses=>json!({"type":"function","name":name,"parameters":tool["inputSchema"]}),
                Protocol::Chat=>json!({"type":"function","function":{"name":name,"parameters":tool["inputSchema"]}}),
                Protocol::Anthropic=>json!({"name":name,"input_schema":tool["inputSchema"],"eager_input_streaming":true}),
            };
            if let Some(description)=tool.get("description") {let description=description.as_str().ok_or(INVALID)?;if protocol==Protocol::Chat{value["function"]["description"]=json!(description);}else{value["description"]=json!(description);}}
            Ok(value)
        }).collect::<Result<Vec<_>>>()?;
        body["tools"] = json!(definitions);
        body["tool_choice"] = if protocol == Protocol::Anthropic {
            json!({"type":"auto"})
        } else {
            json!("auto")
        };
    }
    body["stream"] = json!(true);
    if javascript_stringify(&body).len() > 4 * 1024 * 1024 {
        return Err(Error("The model request exceeds the size limit."));
    }
    Ok(Request { protocol, body })
}
