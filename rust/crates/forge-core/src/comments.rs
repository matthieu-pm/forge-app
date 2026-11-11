pub use crate::contract::ContractError as CommentError;
use crate::contract::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64() != Some(0.0),
        _ => true,
    }
}
fn present(v: &Value, key: &str) -> bool {
    v.get(key).is_some_and(truthy)
}
pub fn safe_link(v: &Value) -> bool {
    let Some(s) = v.as_str() else {
        return false;
    };
    if s.encode_utf16().count() > 2000
        || s.chars()
            .any(|c| c < ' ' || c == '\u{007f}' || crate::text::trim(&c.to_string()).is_empty())
    {
        return false;
    }
    url::Url::parse(s).is_ok_and(|u| {
        ["http", "https", "mailto"].contains(&u.scheme())
            && u.username().is_empty()
            && u.password().is_none_or(|p| p.is_empty())
    })
}
pub fn plain_text(node: &Value) -> String {
    match node["type"].as_str() {
        Some("text") => node["text"].as_str().unwrap_or("").into(),
        Some("mention") => format!("@{}", node["attrs"]["label"].as_str().unwrap_or("")),
        Some("hardBreak") => "\n".into(),
        kind => node["content"]
            .as_array()
            .into_iter()
            .flatten()
            .map(plain_text)
            .collect::<Vec<_>>()
            .join(
                if kind.is_some_and(|s| {
                    ["doc", "bulletList", "orderedList", "blockquote", "listItem"].contains(&s)
                }) {
                    "\n"
                } else {
                    ""
                },
            ),
    }
}
pub fn document(value: Value, draft: bool) -> Result<Value> {
    struct Parser {
        count: usize,
        length: usize,
        draft: bool,
    }
    impl Parser {
        fn visit(&mut self, node: Value, depth: usize, parent: &str) -> Result<Value> {
            self.count += 1;
            if self.count > if self.draft { 100000 } else { 2000 }
                || depth > if self.draft { 64 } else { 12 }
            {
                return Err(ContractError("comment size"));
            }
            let obj = node.as_object().ok_or(ContractError("comment node"))?;
            if obj
                .keys()
                .any(|k| !["type", "text", "attrs", "marks", "content"].contains(&k.as_str()))
            {
                return Err(ContractError("comment attributes"));
            }
            let kind = node["type"].as_str().ok_or(ContractError("comment type"))?;
            let valid = match parent {
                "root" => kind == "doc",
                "paragraph" => ["text", "hardBreak", "mention"].contains(&kind),
                "codeBlock" => kind == "text",
                "bulletList" | "orderedList" => kind == "listItem",
                _ => [
                    "paragraph",
                    "blockquote",
                    "bulletList",
                    "orderedList",
                    "listItem",
                    "codeBlock",
                ]
                .contains(&kind),
            };
            if !valid {
                return Err(ContractError("comment structure"));
            }
            let mut output = json!({"type":kind});
            match kind {
                "text" => {
                    let s = node["text"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .ok_or(ContractError("comment text"))?;
                    if present(&node, "content") || present(&node, "attrs") {
                        return Err(ContractError("comment text"));
                    }
                    self.length += s.encode_utf16().count();
                    output["text"] = json!(s);
                    if present(&node, "marks") {
                        let mut marks = Vec::new();
                        let raw = node["marks"]
                            .as_array()
                            .filter(|a| a.len() <= 5)
                            .ok_or(ContractError("comment marks"))?;
                        for mark in raw {
                            let object = mark.as_object().ok_or(ContractError("comment mark"))?;
                            if object.keys().any(|k| k != "type" && k != "attrs") {
                                return Err(ContractError("comment mark"));
                            }
                            if mark["type"] == "link" {
                                let attrs = mark["attrs"]
                                    .as_object()
                                    .ok_or(ContractError("comment link"))?;
                                if attrs.keys().any(|k| {
                                    !["href", "target", "rel", "class"].contains(&k.as_str())
                                }) || !safe_link(&mark["attrs"]["href"])
                                {
                                    return Err(ContractError("comment link"));
                                }
                                marks.push(
                                    json!({"type":"link","attrs":{"href":mark["attrs"]["href"]}}),
                                );
                            } else {
                                if !mark["type"].as_str().is_some_and(|s| {
                                    ["bold", "italic", "strike", "code"].contains(&s)
                                }) || present(mark, "attrs")
                                {
                                    return Err(ContractError("comment formatting"));
                                }
                                marks.push(json!({"type":mark["type"]}));
                            }
                        }
                        output["marks"] = json!(marks);
                    }
                }
                "mention" => {
                    let attrs = node["attrs"].as_object().ok_or(ContractError("mention"))?;
                    let id = attrs
                        .get("id")
                        .and_then(Value::as_str)
                        .ok_or(ContractError("mention"))?;
                    let label = attrs
                        .get("label")
                        .and_then(Value::as_str)
                        .ok_or(ContractError("mention"))?;
                    if attrs.keys().any(|k| k != "id" && k != "label")
                        || id.is_empty()
                        || id.encode_utf16().count() > 200
                        || label.encode_utf16().count() > 200
                        || ["text", "content", "marks"]
                            .iter()
                            .any(|key| present(&node, key))
                    {
                        return Err(ContractError("mention"));
                    }
                    self.length += label.encode_utf16().count() + 1;
                    output["attrs"] = json!({"id":id,"label":label});
                }
                _ => {
                    if present(&node, "text") || present(&node, "marks") {
                        return Err(ContractError("comment attributes"));
                    }
                    if present(&node, "attrs") {
                        let attrs = &node["attrs"];
                        let empty = match attrs {
                            Value::Object(o) => o.is_empty(),
                            Value::Array(a) => a.is_empty(),
                            Value::String(s) => s.is_empty(),
                            _ => true,
                        };
                        if !empty {
                            let obj = attrs
                                .as_object()
                                .ok_or(ContractError("comment attributes"))?;
                            if kind == "orderedList"
                                && obj.keys().all(|k| k == "start")
                                && attrs["start"]
                                    .as_f64()
                                    .is_some_and(|n| n.fract() == 0.0 && n > 0.0 && n < 10000.0)
                            {
                                output["attrs"] = json!({"start":attrs["start"]});
                            } else if !(kind == "codeBlock"
                                && obj.keys().all(|k| k == "language")
                                && obj.get("language").is_some_and(Value::is_null))
                            {
                                return Err(ContractError("comment attributes"));
                            }
                        }
                    }
                    if kind == "hardBreak" {
                        if present(&node, "content") {
                            return Err(ContractError("line break"));
                        }
                    } else {
                        let children = node
                            .get("content")
                            .map(|v| v.as_array().ok_or(ContractError("comment content")))
                            .transpose()?;
                        let mut content = Vec::new();
                        for child in children.into_iter().flatten() {
                            content.push(self.visit(child.clone(), depth + 1, kind)?);
                        }
                        output["content"] = json!(content);
                    }
                }
            }
            if self.length > if self.draft { 20000000 } else { 10000 } {
                return Err(ContractError("comment length"));
            }
            Ok(output)
        }
    }
    let parsed = Parser {
        count: 0,
        length: 0,
        draft,
    }
    .visit(value, 0, "root")?;
    let plain = plain_text(&parsed);
    if plain.encode_utf16().count() > if draft { 20000000 } else { 10000 }
        || (!draft && crate::text::trim(&plain).is_empty())
    {
        return Err(ContractError("comment length"));
    }
    Ok(parsed)
}
pub fn mention_ids(doc: &Value) -> Vec<String> {
    fn walk(node: &Value, seen: &mut HashSet<String>, ids: &mut Vec<String>) {
        if node["type"] == "mention" {
            if let Some(id) = node["attrs"]["id"].as_str()
                && seen.insert(id.into())
            {
                ids.push(id.into());
            }
        } else {
            for child in node["content"].as_array().into_iter().flatten() {
                walk(child, seen, ids);
            }
        }
    }
    let mut ids = vec![];
    walk(doc, &mut HashSet::new(), &mut ids);
    ids
}
pub fn resolve_mentions(mut doc: Value, people: &HashMap<String, String>) -> Value {
    if doc["type"] == "mention" {
        let label = doc["attrs"]["id"]
            .as_str()
            .and_then(|id| people.get(id))
            .map_or("Member", String::as_str);
        doc["attrs"]["label"] = json!(label);
    }
    if let Some(children) = doc.get_mut("content").and_then(Value::as_array_mut) {
        for child in children {
            *child = resolve_mentions(child.take(), people);
        }
    }
    doc
}
#[derive(Clone, Debug, Serialize)]
#[serde(transparent)]
pub struct CommentCommand(Value);
impl<'de> Deserialize<'de> for CommentCommand {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        Self::parse(Value::deserialize(d)?).map_err(serde::de::Error::custom)
    }
}
impl CommentCommand {
    pub fn parse(v: Value) -> Result<Self> {
        let mut o = Object::new(
            v,
            &[
                "commandKey",
                "teamId",
                "issueId",
                "action",
                "commentId",
                "parentId",
                "expectedVersion",
                "document",
                "uploadIds",
            ],
            true,
        )?;
        for key in ["commandKey", "teamId", "issueId", "commentId"] {
            o.required(key, uuid)?;
        }
        o.required("action", |v| {
            enumeration(v, &["create", "edit", "delete", "restore"])
        })?;
        o.default(
            "parentId",
            json!(""),
            |v| if v == "" { Ok(v) } else { uuid(v) },
        )?;
        o.default("expectedVersion", json!(0), integer)?;
        o.optional("document", |v| document(v, false))?;
        o.optional("uploadIds", |v| list(v, 0, 5, uuid))?;
        let value = o.finish();
        let create = value["action"] == "create";
        let content = create || value["action"] == "edit";
        let ids: Vec<_> = value["uploadIds"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|id| id.as_str().unwrap())
            .collect();
        if content != value.get("document").is_some()
            || (!content && !ids.is_empty())
            || (!create && value["parentId"] != "")
            || ids.iter().collect::<HashSet<_>>().len() != ids.len()
        {
            return Err(ContractError("comment action"));
        }
        Ok(Self(value))
    }
    pub fn as_value(&self) -> &Value {
        &self.0
    }
    pub fn into_value(self) -> Value {
        self.0
    }
}
