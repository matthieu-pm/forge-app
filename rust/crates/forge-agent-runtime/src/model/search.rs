//! The provider-executed search dialects used by the pinned SDK. These helpers do
//! not run host tools or make network requests.
use super::request::Protocol;
use crate::{Error, Result};
use serde_json::{Value, json};
const INVALID: Error = Error("The provider search payload is invalid.");
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().ok_or(INVALID)
}
fn nullable(v: &Value, key: &str) -> Result<Value> {
    match v.get(key) {
        Some(Value::String(_) | Value::Null) => Ok(v[key].clone()),
        _ => Err(INVALID),
    }
}
pub fn descriptor(protocol: Protocol) -> Option<Value> {
    let id = match protocol {
        Protocol::Responses => "openai.web_search",
        Protocol::Anthropic => "anthropic.web_search_20250305",
        Protocol::Chat => return None,
    };
    Some(json!({"type":"provider","id":id,"name":"web_search","args":{}}))
}
pub(super) fn definition(protocol: Protocol, tool: &Value) -> Result<Option<Value>> {
    if tool["name"] != "web_search"
        || tool["args"] != json!({})
        || tool.as_object().is_none_or(|o| o.len() != 4)
    {
        return Err(INVALID);
    }
    match (protocol, text(tool, "id")?) {
        (Protocol::Responses, "openai.web_search") => Ok(Some(json!({"type":"web_search"}))),
        (Protocol::Anthropic, "anthropic.web_search_20250305") => Ok(Some(
            json!({"type":"web_search_20250305","name":"web_search"}),
        )),
        (Protocol::Chat, "openai.web_search") => Ok(None),
        _ => Err(INVALID),
    }
}
pub(super) fn call(part: &Value) -> Result<()> {
    if part["toolName"] != "web_search"
        || part["providerExecuted"] != true
        || text(part, "toolCallId")?.is_empty()
        || !part["input"].is_object()
    {
        return Err(INVALID);
    }
    Ok(())
}
pub(super) fn response_result(part: &Value) -> Result<Value> {
    if part["toolName"] != "web_search" {
        return Err(INVALID);
    }
    let id = part["providerOptions"]["openai"]["itemId"]
        .as_str()
        .unwrap_or(text(part, "toolCallId")?);
    if id.is_empty() {
        return Err(INVALID);
    }
    Ok(json!({"type":"item_reference","id":id}))
}
pub(super) fn anthropic_request_result(part: &Value) -> Result<Value> {
    if part["toolName"] != "web_search" {
        return Err(INVALID);
    }
    let output = &part["output"];
    let content=match text(output,"type")? {
        "json"=>Value::Array(output["value"].as_array().ok_or(INVALID)?.iter().map(|v|{
            if v["type"]!="web_search_result"{return Err(INVALID);}
            Ok(json!({"type":"web_search_result","url":text(v,"url")?,"title":nullable(v,"title")?,"page_age":nullable(v,"pageAge")?,"encrypted_content":text(v,"encryptedContent")?}))
        }).collect::<Result<Vec<_>>>()?),
        "error-json"=>json!({"type":"web_search_tool_result_error","error_code":output["value"]["errorCode"].as_str().unwrap_or("unavailable")}),
        _=>return Err(INVALID),
    };
    Ok(
        json!({"type":"web_search_tool_result","tool_use_id":text(part,"toolCallId")?,"content":content}),
    )
}
pub(super) fn response_output(action: &Value) -> Result<Value> {
    if action.is_null() {
        return Ok(json!({}));
    }
    match text(action, "type")? {
        "search" => {
            let mut result = json!({"action":{"type":"search"}});
            if !action["query"].is_null() {
                result["action"]["query"] = json!(text(action, "query")?);
            }
            if !action["queries"].is_null() {
                let values = action["queries"]
                    .as_array()
                    .filter(|v| v.iter().all(Value::is_string))
                    .ok_or(INVALID)?;
                result["action"]["queries"] = json!(values);
            }
            if !action["sources"].is_null() {
                let values = action["sources"].as_array().ok_or(INVALID)?;
                result["sources"] = Value::Array(
                    values
                        .iter()
                        .map(|v| match text(v, "type")? {
                            "url" => Ok(json!({"type":"url","url":text(v,"url")?})),
                            "api" => Ok(json!({"type":"api","name":text(v,"name")?})),
                            _ => Err(INVALID),
                        })
                        .collect::<Result<Vec<_>>>()?,
                );
            }
            Ok(result)
        }
        "open_page" | "find_in_page" => {
            let find = action["type"] == "find_in_page";
            let mut result = json!({"action":{"type":if find{"findInPage"}else{"openPage"}}});
            for key in if find {
                &["url", "pattern"][..]
            } else {
                &["url"][..]
            } {
                if action.get(*key).is_some() {
                    result["action"][*key] = nullable(action, key)?;
                }
            }
            Ok(result)
        }
        _ => Err(INVALID),
    }
}
pub(super) fn anthropic_output(content: &Value) -> Result<Value> {
    if let Some(values) = content.as_array() {
        return Ok(json!({"type":"json","value":values.iter().map(|v|{
            if v["type"]!="web_search_result" {return Err(INVALID);}
            Ok(json!({"type":"web_search_result","url":text(v,"url")?,"title":text(v,"title")?,"pageAge":if v.get("page_age").is_none(){Value::Null}else{nullable(v,"page_age")?},"encryptedContent":text(v,"encrypted_content")?}))
        }).collect::<Result<Vec<_>>>()?}));
    }
    if content["type"] != "web_search_tool_result_error" {
        return Err(INVALID);
    }
    Ok(
        json!({"type":"error-json","value":{"type":"web_search_tool_result_error","errorCode":text(content,"error_code")?}}),
    )
}

pub(super) fn citation(protocol: Protocol, value: &Value) -> Result<Value> {
    let mut source = json!({"url":text(value,"url")?,"title":text(value,"title")?});
    match protocol {
        Protocol::Responses => {
            if value["type"] != "url_citation" {
                return Err(INVALID);
            }
            let start = value["start_index"]
                .as_u64()
                .filter(|n| *n <= 9_007_199_254_740_991)
                .ok_or(INVALID)?;
            let end = value["end_index"]
                .as_u64()
                .filter(|n| *n <= 9_007_199_254_740_991)
                .ok_or(INVALID)?;
            if end < start {
                return Err(INVALID);
            }
            source["startIndex"] = json!(start);
            source["endIndex"] = json!(end);
        }
        Protocol::Anthropic => {
            if value["type"] != "web_search_result_location" {
                return Err(INVALID);
            }
            text(value, "encrypted_index")?;
            source["citedText"] = json!(text(value, "cited_text")?);
        }
        Protocol::Chat => return Err(INVALID),
    }
    Ok(source)
}
