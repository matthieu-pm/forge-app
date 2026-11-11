//! Private checkpoint serialization and bounded client projections.
use super::*;

fn entries(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}
fn remove(v: &mut Value, keys: &[&str]) {
    if let Some(o) = v.as_object_mut() {
        for key in keys {
            o.remove(*key);
        }
    }
}
pub fn encode(manifest: &Value) -> String {
    let mut m = manifest.clone();
    for s in m["sources"].as_array_mut().into_iter().flatten() {
        remove(s, &["raw"]);
    }
    for e in m["entries"].as_array_mut().into_iter().flatten() {
        remove(e, &["draft", "project", "content", "title"]);
        for c in e
            .get_mut("conflict")
            .and_then(|v| v.get_mut("candidates"))
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            *c = json!({"id":c["id"],"revision":c["revision"]});
        }
        for f in e["files"].as_array_mut().into_iter().flatten() {
            remove(f, &["data"]);
        }
    }
    javascript_stringify(&m)
}
fn bounded(s: String) -> String {
    let mut units = 0;
    s.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 4000
        })
        .collect()
}
pub fn review_summary(entry: &Value) -> Option<String> {
    let c = entry.get("content")?;
    let f = &c["fields"];
    Some(match text(c, "kind") {
        "document" => bounded(crate::documents::plain_text(&f["body"])),
        "initiative" | "milestone" => bounded(format!(
            "{}\n{}",
            f.get("summary")
                .unwrap_or(&f["name"])
                .as_str()
                .unwrap_or_default(),
            if f["description"].is_null() {
                String::new()
            } else {
                crate::documents::plain_text(&f["description"])
            }
        )),
        "view" => bounded(
            serde_json::to_string_pretty(
                &json!({"kind":c["definition"]["kind"],"filters":c["definition"]["filters"]}),
            )
            .unwrap(),
        ),
        _ => f
            .get("url")
            .unwrap_or(&f["name"])
            .as_str()
            .unwrap_or_default()
            .into(),
    })
}
pub fn snapshot(manifest: &Value, include_file_data: bool) -> Value {
    let all = entries(&manifest["entries"]);
    let pending: Vec<_> = all.iter().filter(|e| e["state"] == "pending").collect();
    let files: Vec<_> = all
        .iter()
        .filter(|e| {
            e["state"] == "saved"
                && entries(&e["files"])
                    .iter()
                    .any(|f| !crate::comments::truthy(&f["fileId"]))
        })
        .collect();
    let mut m = manifest.clone();
    remove(&mut m, &["referenceContext"]);
    m["totalCount"] = json!(all.len());
    m["savedCount"] = json!(all.iter().filter(|e| e["state"] == "saved").count());
    m["pendingCount"] = json!(pending.len());
    m["fileCount"] = json!(
        files
            .iter()
            .map(|e| entries(&e["files"])
                .iter()
                .filter(|f| !crate::comments::truthy(&f["fileId"]))
                .count())
            .sum::<usize>()
    );
    for s in m["sources"].as_array_mut().into_iter().flatten() {
        remove(s, &["raw"]);
    }
    let mut seen = HashSet::new();
    let visible: Vec<_> = pending
        .into_iter()
        .chain(files.iter().copied())
        .chain(all.iter().filter(|e| e["state"] == "review"))
        .chain(all)
        .filter(|e| seen.insert(text(e, "id")))
        .take(100)
        .map(|entry| {
            let mut e = entry.clone();
            remove(&mut e, &["content", "reviewSummary"]);
            if e["state"] == "review" {
                if let Some(s) = review_summary(entry) {
                    e["reviewSummary"] = json!(s);
                }
                if e["draft"].is_object() {
                    for k in ["comments", "activity", "attachments", "reactions"] {
                        e["draft"][k] = json!([]);
                    }
                    e["draft"]["descriptionDoc"] = Value::Null;
                }
                if e["project"].is_object() {
                    for k in ["comments", "updates", "resources", "milestones"] {
                        e["project"][k] = json!([]);
                    }
                    e["project"]["description"] = Value::Null;
                }
            } else {
                remove(&mut e, &["draft", "project"]);
            }
            let data = include_file_data && files.first().is_some_and(|f| f["id"] == e["id"]);
            for f in e["files"].as_array_mut().into_iter().flatten() {
                if !data || crate::comments::truthy(&f["fileId"]) {
                    f["data"] = json!("");
                }
            }
            e
        })
        .collect();
    m["entries"] = json!(visible);
    m
}
pub fn content_dependencies(entry: &Value) -> Vec<(String, String)> {
    let c = &entry["content"];
    match text(c, "kind") {
        "initiative" => entries(&c["projectIds"])
            .iter()
            .filter_map(Value::as_str)
            .map(|s| ("project".into(), s.into()))
            .collect(),
        "milestone" | "document" if !text(c, "projectId").is_empty() => {
            vec![("project".into(), text(c, "projectId").into())]
        }
        "document" | "resource" if !text(c, "sectionId").is_empty() => vec![(
            "resource".into(),
            format!("section:{}", text(c, "sectionId")),
        )],
        "view" => {
            let d = &c["definition"];
            entries(if d["kind"] == "issues" {
                &d["filters"]["rules"]
            } else {
                &d["filters"]
            })
            .iter()
            .filter_map(|r| {
                if text(r, "value").is_empty() || ["set", "notSet"].contains(&text(r, "operator")) {
                    return None;
                }
                let kind = match text(r, "field") {
                    "project" | "Specific project" => "project",
                    "parentId" => "issue",
                    _ => return None,
                };
                Some((kind.into(), text(r, "value").into()))
            })
            .collect()
        }
        _ => vec![],
    }
}
pub fn references<'a>(
    manifest: &'a Value,
    entry: &Value,
    kind: &str,
    legacy_id: &str,
) -> Vec<&'a Value> {
    if legacy_id.is_empty() {
        return vec![];
    }
    let matches = |e: &&Value| {
        e["kind"] == kind
            && (e["legacyId"] == legacy_id
                || entries(&e["legacyAliases"]).iter().any(|v| v == legacy_id))
            && (["project", "initiative", "view", "milestone"].contains(&kind)
                || entry["kind"] == "view"
                || e["teamId"] == entry["teamId"])
    };
    let local: Vec<_> = entries(&manifest["entries"])
        .iter()
        .filter(matches)
        .collect();
    let matching = if local.is_empty() {
        entries(&manifest["referenceContext"])
            .iter()
            .filter(matches)
            .collect()
    } else {
        local
    };
    let same: Vec<_> = matching
        .iter()
        .copied()
        .filter(|e| {
            e["sourceKey"] == entry["sourceKey"] && e["sourceChecksum"] == entry["sourceChecksum"]
        })
        .collect();
    if !same.is_empty() {
        return same;
    }
    let source: Vec<_> = matching
        .iter()
        .copied()
        .filter(|e| e["sourceKey"] == entry["sourceKey"])
        .collect();
    if !source.is_empty() { source } else { matching }
}
