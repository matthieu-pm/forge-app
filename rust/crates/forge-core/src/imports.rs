//! Legacy content is inventoried from immutable source bytes before execution.
use crate::{
    canonical::{command_input_hash as hash, javascript_stringify},
    contract::{self as c, ContractError, Object},
    issues, planning,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
pub mod checkpoint;
mod content;
pub use content::content_entries;
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct ImportError(pub String);
impl From<ContractError> for ImportError {
    fn from(e: ContractError) -> Self {
        Self(e.to_string())
    }
}
type Result<T> = std::result::Result<T, ImportError>;
fn fail(s: &str) -> ImportError {
    ImportError(s.into())
}
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Modules {
    pub initiatives: bool,
    pub documents: bool,
    pub views: bool,
    pub resources: bool,
    pub milestones: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub key: String,
    pub raw: String,
}
pub fn request(v: Value, kind: &str) -> c::Result<Value> {
    let mut keys = vec!["workspaceId", "sessionId"];
    if kind != "identity" {
        keys.extend(["id", "revision"])
    }
    match kind {
        "choice" => keys.extend([
            "entryId",
            "choice",
            "conflictFingerprint",
            "ownershipConfirmed",
        ]),
        "file" => keys.extend(["entryId", "index", "fileId"]),
        "cutover" => keys.extend(["action", "reportFingerprint", "acknowledgeExclusions"]),
        "identity" | "request" => {}
        _ => return Err(ContractError("import request")),
    }
    let mut o = Object::new(v, &keys, false)?;
    for k in ["workspaceId", "sessionId"] {
        o.required(k, |v| c::text(v, 1, usize::MAX, false))?;
    }
    if kind != "identity" {
        o.required("id", c::uuid)?;
        o.required("revision", c::integer)?
    }
    match kind {
        "choice" => {
            o.required("entryId", |v| c::text(v, 1, usize::MAX, false))?;
            o.required("choice", |v| {
                c::enumeration(
                    v,
                    &[
                        "keep-server",
                        "keep-both",
                        "skip",
                        "migrate-files",
                        "confirm-content",
                    ],
                )
            })?;
            o.required("conflictFingerprint", |v| c::text(v, 64, 64, false))?;
            o.optional("ownershipConfirmed", |v| {
                if v == true {
                    Ok(v)
                } else {
                    Err(ContractError("ownership confirmation"))
                }
            })?
        }
        "file" => {
            o.required("entryId", |v| c::text(v, 1, usize::MAX, false))?;
            o.required("index", |v| c::number(v, 0., 4., true))?;
            o.required("fileId", c::uuid)?
        }
        "cutover" => {
            o.required("action", |v| {
                c::enumeration(v, &["reconcile", "complete", "cleanup"])
            })?;
            o.optional("reportFingerprint", |v| c::text(v, 64, 64, false))?;
            o.default("acknowledgeExclusions", json!(false), c::boolean)?
        }
        _ => {}
    }
    Ok(o.finish())
}
fn string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(a) => a
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => javascript_stringify(v),
    }
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}
fn array(v: Option<&Value>) -> Result<&[Value]> {
    match v {
        None => Ok(&[]),
        Some(Value::Array(a)) => Ok(a),
        _ => Err(fail("Invalid collection.")),
    }
}
fn has(v: &Value, k: &str) -> bool {
    v.get(k).is_some()
}
fn nullish<'a>(v: &'a Value, k: &str, fallback: &'a Value) -> &'a Value {
    v.get(k).filter(|v| !v.is_null()).unwrap_or(fallback)
}
fn object(v: &Value) -> Value {
    if v.is_object() { v.clone() } else { json!({}) }
}
pub fn attachment_anchor(file: &Value) -> String {
    if let Some(id) = file["id"].as_str().filter(|s| !s.is_empty()) {
        return id.into();
    }
    let mut h = 2166136261u32;
    for unit in format!("{}{}", text(file, "name"), text(file, "data")).encode_utf16() {
        h = (h ^ u32::from(unit)).wrapping_mul(16777619)
    }
    format!("file-{h:x}")
}
pub fn validated_files(files: &[Value]) -> Result<Vec<Value>> {
    let re = regex::Regex::new(r"^data:([a-zA-Z0-9.+/-]*);base64,([A-Za-z0-9+/]*={0,2})$").unwrap();
    let mut result = vec![];
    for file in files {
        let m = re
            .captures(text(file, "data"))
            .filter(|_| !crate::comments::truthy(&file["fileId"]))
            .ok_or_else(|| fail("A legacy file has no valid source bytes."))?;
        let bytes = STANDARD
            .decode(&m[2])
            .map_err(|_| fail("A legacy file is corrupt."))?;
        if bytes.is_empty() || STANDARD.encode(&bytes) != m[2] {
            return Err(fail("A legacy file is corrupt."));
        }
        let name = c::text(file["name"].clone(), 1, 200, true)?;
        if name
            .as_str()
            .unwrap()
            .chars()
            .any(|c| c == '/' || c == '\\' || (c as u32) <= 31 || c == '\u{7f}')
        {
            return Err(fail(
                "File names cannot contain paths or control characters.",
            ));
        }
        let content_type = if m[1].is_empty() {
            "application/octet-stream".into()
        } else {
            crate::text::trim(&m[1]).to_lowercase()
        };
        let content_type = c::pattern(
            c::text(json!(content_type), 0, 120, false)?,
            r"^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$",
        )?;
        let checksum = format!("{:x}", Sha256::digest(&bytes));
        if (crate::comments::truthy(&file["checksum"]) && file["checksum"] != checksum)
            || (crate::comments::truthy(&file["sizeBytes"])
                && file["sizeBytes"].as_f64() != Some(bytes.len() as f64))
        {
            return Err(fail(
                "A legacy file checksum or size does not match its bytes.",
            ));
        }
        let mut v = json!({"name":name,"legacyId":attachment_anchor(file),"data":file["data"],"contentType":content_type,"sizeBytes":bytes.len(),"checksum":checksum});
        if crate::comments::truthy(&file["width"]) {
            v["width"] = file["width"].clone()
        }
        result.push(v)
    }
    Ok(result)
}
fn issue_record(v: Value, kind: &str, status: &str) -> c::Result<Value> {
    if kind == "team-issues" {
        return issues::team_issue(v);
    }
    let mut d = issues::blank(status);
    let keys = if kind == "cycle-issues" {
        &["title", "description", "status", "priority", "cycle"][..]
    } else {
        &[
            "title",
            "description",
            "priority",
            "dueDate",
            "assignee",
            "project",
            "labels",
            "templateName",
            "attachments",
            "snoozed",
        ][..]
    };
    for k in keys {
        if let Some(value) = v.get(k) {
            d[*k] = value.clone()
        }
    }
    for k in if kind == "cycle-issues" {
        &["cycle", "status"][..]
    } else {
        &["dueDate"][..]
    } {
        c::text(
            v[*k].clone(),
            usize::from(k != &"dueDate"),
            usize::MAX,
            false,
        )?;
    }
    for k in ["title", "description", "priority"] {
        if !has(&v, k) {
            return Err(ContractError("legacy issue"));
        }
    }
    if kind == "triage-issues" {
        d["snoozed"] = c::boolean(v["snoozed"].clone())?;
        d["triage"] = json!(true)
    }
    d["title"] = c::text(v["title"].clone(), 1, 240, true)?;
    let mut record = issues::draft(d, false)?;
    record["id"] = c::text(v["id"].clone(), 1, usize::MAX, false)?;
    record["number"] = c::number(v["number"].clone(), 1., 9007199254740991., true)?;
    record["createdAt"] = c::datetime(v["createdAt"].clone())?;
    Ok(record)
}

pub fn build(
    id: &str,
    actor: &str,
    workspace: &str,
    input: &[Source],
    status: &str,
    modules: Option<Modules>,
    now: &str,
) -> Result<Value> {
    let mut seen = HashSet::new();
    let mut sources: Vec<_> = input
        .iter()
        .filter(|s| seen.insert((s.key.clone(), s.raw.clone())))
        .cloned()
        .collect();
    let collator = icu_collator::Collator::try_new(Default::default(), Default::default())
        .map_err(|_| fail("Source ordering failed."))?;
    sources.sort_by(|a, b| {
        collator
            .compare(&a.key, &b.key)
            .then_with(|| collator.compare(&a.raw, &b.raw))
    });
    let sources: Vec<Value> = sources
        .into_iter()
        .map(|s| json!({"key":s.key,"raw":s.raw,"checksum":hash(&json!(s.raw))}))
        .collect();
    if javascript_stringify(&json!(sources)).len() > 200_000_000 {
        return Err(fail("The import exceeds 200 MB. Split the source first."));
    }
    let mut entries = vec![];
    let mut exclusions = vec![];
    let mut errors = vec![];
    let mut count = 0;
    let teams =
        regex::Regex::new(r"^forge:(team-issues|triage-issues|cycle-issues):v1:([^:]+)$").unwrap();
    let home = regex::Regex::new(r"^forge:team-home:v1:[^:]+$").unwrap();
    for source in &sources {
        let key = text(source, "key");
        let checksum = text(source, "checksum");
        let team = teams.captures(key);
        let project = key == format!("forge:workspace:{workspace}:initiatives:v1");
        let content = modules.is_some()
            && (project
                || home.is_match(key)
                || key == format!("forge:workspace:{workspace}:custom-views:v1:{actor}"));
        if team.is_none() && !project && !content {
            exclusions.push(format!("{key}: no enabled core adapter."));
            continue;
        }
        let process = (|| -> Result<()> {
            let body = crate::json::parse(text(source, "raw"))
                .map_err(|_| fail("Invalid source JSON."))?;
            if !body.is_array()
                && body["version"] != 1
                && !(key.starts_with("forge:team-home:v1:") && !has(&body, "version"))
            {
                return Err(fail("Unsupported source schema version."));
            }
            if content {
                let (mut child, mut excluded) =
                    content_entries(key, checksum, &body, actor, workspace, modules.unwrap())?;
                count += child.len();
                entries.append(&mut child);
                exclusions.append(&mut excluded);
                if count > 100_000 {
                    return Err(fail("The import exceeds 100,000 records."));
                }
            }
            let mut collections: Vec<(String, Value)> = vec![];
            if project {
                collections.push((
                    "workspaceProjects".into(),
                    nullish(&body, "workspaceProjects", &json!([])).clone(),
                ));
                for (i, item) in array(body.get("initiatives").filter(|v| !v.is_null()))?
                    .iter()
                    .enumerate()
                {
                    if item.is_null() {
                        return Err(fail("Invalid collection."));
                    }
                    collections.push((
                        format!("initiatives/{i}/projects"),
                        nullish(item, "projects", &json!([])).clone(),
                    ))
                }
            } else if let Some(team) = &team {
                collections.push((
                    if &team[1] == "team-issues" {
                        "issues"
                    } else {
                        "records"
                    }
                    .into(),
                    if &team[1] == "team-issues" {
                        body["issues"].clone()
                    } else {
                        body.clone()
                    },
                ))
            }
            for (collection, values) in collections {
                for (index, value) in array(Some(&values))?.iter().enumerate() {
                    count += 1;
                    if count > 100_000 {
                        return Err(fail("The import exceeds 100,000 records."));
                    }
                    let path = format!("{collection}/{index}");
                    let mut entry = json!({"id":hash(&json!([key,checksum,path])),"sourceKey":key,"sourceChecksum":checksum,"path":path,"kind":if project{"project"}else{"issue"},"teamId":team.as_ref().map(|t|&t[2]).unwrap_or(""),"legacyId":string(nullish(value,"id",&json!(""))),"fingerprint":hash(value),"title":value["title"].as_str().or(value["name"].as_str()).unwrap_or("Invalid source record"),"files":[],"state":"pending","sourceValid":true});
                    if has(value, "revision") {
                        entry["canonicalProjection"] = json!(true)
                    }
                    let validated = (|| -> Result<()> {
                        if entry["canonicalProjection"] == true {
                            entry["canonicalId"] = c::uuid(value["id"].clone())?;
                            c::integer(value["revision"].clone())?;
                            entry["reviewRequired"] = json!(true)
                        }
                        if project {
                            let mut value = value.clone();
                            if modules.is_some() {
                                value = object(&value);
                                value["milestones"] = json!([]);
                                value["resources"] = json!([])
                            }
                            let p = planning::project(value)?;
                            if array(p.get("teamIds"))?.is_empty() {
                                return Err(fail("Choose a team for this project before import."));
                            }
                            if ["labelIds", "dependencyIds", "milestones", "resources"]
                                .iter()
                                .any(|k| p[*k].as_array().is_some_and(|v| !v.is_empty()))
                            {
                                exclusions.push(format!("{key}/{path}: advanced project labels, dependencies, milestones and resources remain in the private source."))
                            }
                            entry["teamIds"] = p["teamIds"].clone();
                            entry["teamId"] = p["teamIds"][0].clone();
                            entry["legacyId"] = p["id"].clone();
                            entry["project"] = p;
                        } else {
                            let record =
                                issue_record(value.clone(), &team.as_ref().unwrap()[1], status)?;
                            c::text(record["id"].clone(), 1, 255, false)?;
                            entry["legacyId"] = record["id"].clone();
                            let mut draft = record.clone();
                            draft["subIssues"] = json!([]);
                            entry["draft"] = issues::draft(draft, false)?;
                            if !array(record.get("subIssues"))?.is_empty() {
                                exclusions.push(format!("{key}/{path}: child-title drafts retained; only identified issues are imported."))
                            }
                            if crate::comments::truthy(&record["milestone"]) {
                                exclusions.push(format!("{key}/{path}: the legacy milestone remains in the private source until its planning adapter is enabled."))
                            }
                            entry["files"] = json!(if entry["canonicalProjection"] == true {
                                vec![]
                            } else {
                                validated_files(array(record.get("attachments"))?)?
                            });
                            entry["fingerprint"] = json!(hash(
                                &json!({"draft":entry["draft"],"files":entry["files"]})
                            ));
                        }
                        Ok(())
                    })();
                    if let Err(error) = validated {
                        entry["sourceValid"] = json!(false);
                        entry["state"] = json!("quarantined");
                        entry["message"] = json!(error.to_string())
                    }
                    entries.push(entry)
                }
            }
            exclusions.push(format!("{key}: historical authors, comments, reactions, automations, documents and views are preserved privately; no historical notifications are replayed."));
            Ok(())
        })();
        if let Err(error) = process {
            if error.0.contains("100,000") {
                return Err(error);
            }
            errors.push(format!("{key}: source could not be parsed completely."));
            exclusions.push(format!("{key}: {error} Exact bytes preserved."));
        }
    }
    let headers: Vec<_> = sources
        .iter()
        .map(|s| json!({"key":s["key"],"checksum":s["checksum"]}))
        .collect();
    let mut fingerprint = json!({"version":1,"sources":headers});
    let mut manifest = json!({"version":1,"policyVersion":1,"id":id,"actorId":actor,"workspaceId":workspace,"revision":0,"sources":sources,"entries":entries,"exclusions":exclusions,"sourceErrors":errors,"createdAt":now});
    if let Some(modules) = modules {
        fingerprint["contentVersion"] = json!(2);
        fingerprint["modules"] = json!(modules);
        manifest["contentVersion"] = json!(2);
        manifest["modules"] = json!(modules)
    }
    manifest["fingerprint"] = json!(hash(&fingerprint));
    Ok(manifest)
}
