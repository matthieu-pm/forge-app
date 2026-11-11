//! Reviewed preference imports preserve the exact source and per-field baseline.
use super::*;
use sha2::{Digest, Sha256};
pub fn identity(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["userId", "sessionId", "workspaceId"], true)?;
    for k in ["userId", "sessionId", "workspaceId"] {
        o.required(k, |v| text(v, 1, usize::MAX, false))?;
    }
    Ok(o.finish())
}
pub fn source(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["location", "key", "raw", "recovery"], true)?;
    o.required("location", |v| {
        enumeration(v, &["local", "session", "saved"])
    })?;
    o.required("key", |v| text(v, 1, 500, false))?;
    o.required("raw", |v| text(v, 0, 500_000, false))?;
    o.optional("recovery", |v| {
        let mut o = Object::new(v, &["key", "raw"], true)?;
        o.required("key", |v| text(v, 0, 500, false))?;
        o.required("raw", |v| text(v, 0, 600_000, false))?;
        Ok(o.finish())
    })?;
    Ok(o.finish())
}
pub fn group(key: &str, user: &str) -> Option<&'static str> {
    if key == "forge.personal-preferences" {
        return Some("general");
    }
    let re =
        regex::Regex::new(r"^forge:(calls-and-transcripts|notifications):v([0-9]+):(.+)$").unwrap();
    let m = re.captures(key)?;
    if &m[3] != user {
        return None;
    }
    Some(if &m[1] == "notifications" {
        "notifications"
    } else {
        "calls"
    })
}
pub fn inspect(source: &Value, user: &str) -> Value {
    fn rejected(message: &str) -> Value {
        json!({"fields":{},"exclusions":[message]})
    }
    if let Some(recovery) = source.get("recovery") {
        let valid = source["location"] == "saved"
            && recovery["key"]
                .as_str()
                .is_some_and(|s| s.starts_with("forge:legacy-conflict:v1:"))
            && recovery["raw"]
                .as_str()
                .and_then(|s| crate::json::parse(s).ok())
                .is_some_and(|v| v["key"] == source["key"] && v["value"] == source["raw"]);
        if !valid {
            return rejected("Invalid recovery copy; all fields excluded.");
        }
    }
    let key = source["key"].as_str().unwrap_or_default();
    let Some(group) = group(key, user) else {
        return rejected("Unsupported source or another account's preferences.");
    };
    if group != "general"
        && crate::product_state::capture(key, r"^forge:[^:]+:v([0-9]+):").as_deref() != Some("1")
    {
        return rejected("Future source version; all fields excluded.");
    }
    let Some(raw) = source["raw"].as_str() else {
        return rejected("Corrupt JSON; all fields excluded.");
    };
    let Ok(parsed) = crate::json::parse(raw) else {
        return rejected("Corrupt JSON; all fields excluded.");
    };
    let Some(mut values) = parsed.as_object() else {
        return rejected("Invalid source; all fields excluded.");
    };
    let mut exclusions = vec![];
    if let Some(version) = values.get("version") {
        if version != 1 {
            return rejected("Future or unsupported schema version; all fields excluded.");
        }
        let Some(inner) = values.get("values").and_then(Value::as_object) else {
            return rejected("Invalid source envelope; all fields excluded.");
        };
        for k in values
            .keys()
            .filter(|k| !["version", "values"].contains(&k.as_str()))
        {
            exclusions.push(format!("Excluded metadata: {k}"))
        }
        values = inner;
    }
    fn walk(
        schema: &Value,
        value: &Value,
        path: &str,
        fields: &mut Map<String, Value>,
        excluded: &mut Vec<String>,
    ) {
        if kind(schema) == "object" {
            let Some(value) = value.as_object() else {
                excluded.push(format!("{path}: invalid value"));
                return;
            };
            for (k, v) in value {
                let path = format!("{path}.{k}");
                if let Some(s) = schema["fields"].get(k) {
                    walk(s, v, &path, fields, excluded)
                } else {
                    excluded.push(format!("{path}: unsupported field"))
                }
            }
        } else {
            match parse(schema, Some(value), false) {
                Ok(Some(v)) => {
                    fields.insert(path.into(), v);
                }
                _ => excluded.push(format!("{path}: invalid value")),
            }
        }
    }
    let mut fields = Map::new();
    walk(
        &schemas()["account"]["fields"][group],
        &Value::Object(values.clone()),
        group,
        &mut fields,
        &mut exclusions,
    );
    json!({"fields":fields,"exclusions":exclusions})
}
pub fn fingerprint(source: &Value) -> String {
    let v = json!([
        source["location"],
        source["key"],
        source["raw"],
        source.get("recovery").unwrap_or(&Value::Null)
    ]);
    format!(
        "{:x}",
        Sha256::digest(crate::canonical::javascript_stringify(&v).as_bytes())
    )
}
fn digest(v: Value) -> Result<Value> {
    pattern(v, r"^[a-f0-9]{64}$")
}
fn choices(v: Value, allowed: &[&str]) -> Result<Value> {
    let mut v = record(v)?;
    for x in v.as_object_mut().unwrap().values_mut() {
        *x = enumeration(x.take(), allowed)?
    }
    Ok(v)
}
pub fn plan(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "id",
            "identity",
            "source",
            "fingerprint",
            "ownershipConfirmed",
            "snapshot",
            "choices",
        ],
        true,
    )?;
    o.required("id", uuid)?;
    o.required("identity", identity)?;
    o.required("source", source)?;
    o.required("fingerprint", digest)?;
    o.required("ownershipConfirmed", |v| literal(v, json!(true)))?;
    o.required("snapshot", snapshot)?;
    o.required("choices", |v| choices(v, &["keep", "import"]))?;
    Ok(o.finish())
}
pub fn validate(v: Value) -> Result<Value> {
    let mut v = plan(v)?;
    if v["snapshot"]["userId"] != v["identity"]["userId"]
        || v["snapshot"].get("workspaceId").is_some()
    {
        return Err(ContractError("destination account"));
    }
    let data = inspect(&v["source"], v["identity"]["userId"].as_str().unwrap());
    let fields = data["fields"].as_object().unwrap();
    let choices = v["choices"].as_object().unwrap();
    if fields.is_empty()
        || fields.len() != choices.len()
        || fields.keys().any(|k| !choices.contains_key(k))
        || !choices.values().any(|v| v == "import")
    {
        return Err(ContractError("review every preference"));
    }
    let imported: HashSet<String> = fields
        .keys()
        .filter(|k| choices[*k] == "import")
        .cloned()
        .collect();
    for k in ["values", "fieldVersions"] {
        v["snapshot"][k]
            .as_object_mut()
            .unwrap()
            .retain(|k, _| imported.contains(k));
    }
    Ok(v)
}
pub fn request(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["identity", "id", "fingerprint", "path"], true)?;
    o.required("identity", identity)?;
    o.required("id", uuid)?;
    o.required("fingerprint", digest)?;
    o.required("path", |v| text(v, 1, 200, false))?;
    Ok(o.finish())
}
pub fn manifest(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["plan", "fields"], true)?;
    o.required("plan", plan)?;
    o.required("fields", |v| {
        choices(v, &["pending", "saved", "conflict", "kept"])
    })?;
    Ok(o.finish())
}
/// Durable checkpoints exclude raw source and baseline values from shared recovery capture.
pub fn split(manifest: &Value) -> (Value, Value, Value) {
    let mut checkpoint = manifest.clone();
    let source = checkpoint["plan"]["source"].take();
    let baseline = checkpoint["plan"]["snapshot"]
        .as_object_mut()
        .unwrap()
        .remove("values")
        .unwrap();
    let mut header = json!({"location":source["location"],"key":source["key"]});
    if let Some(r) = source.get("recovery") {
        header["recoveryKey"] = r["key"].clone()
    }
    checkpoint["plan"]["source"] = header;
    (checkpoint, source, baseline)
}
pub fn hydrate(mut checkpoint: Value, source: Value, baseline: Value) -> Result<Value> {
    checkpoint["plan"]["source"] = source;
    checkpoint["plan"]["snapshot"]["values"] = baseline;
    manifest(checkpoint)
}
