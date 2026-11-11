//! Owner-scoped import checkpoints backed by immutable private source copies.
use crate::{Database, StoreError, authority::current_actor, resource_policy as policy};
use chrono::{SecondsFormat, Utc};
use forge_core::{
    actor::{Actor, Authentication},
    canonical::{command_input_hash as hash, javascript_stringify},
    imports::{self as contract, Modules, Source, checkpoint},
};
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;
mod create;
mod execution;
mod references;
mod review;
mod targets;
pub use execution::{batch, choose, pause, read_one};
mod reconciliation;
pub use reconciliation::{cutover, download_report, retry};
mod files;
pub use files::finalize_file;
use targets::{conversion_available, target};

#[derive(Clone, Copy, Default)]
pub struct ImportOptions {
    pub modules: Modules,
}
impl ImportOptions {
    pub fn from_env() -> Self {
        let docs = crate::documents::DocumentOptions::from_env();
        Self {
            modules: Modules {
                initiatives: crate::initiatives::InitiativeOptions::from_env().enabled,
                documents: docs.enabled,
                resources: docs.team_resources,
                views: crate::saved_views::ViewOptions::from_env().enabled,
                milestones: true,
            },
        }
    }
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}
fn array<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v[k].as_array().map(Vec::as_slice).unwrap_or_default()
}
fn legacy_uuid(value: &str) -> Option<Uuid> {
    forge_core::text::is_uuid(value)
        .then(|| value.parse().ok())
        .flatten()
}
fn id(v: &Value, k: &str) -> Result<Uuid, StoreError> {
    text(v, k).parse().map_err(|_| StoreError::InvalidInput)
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn remove(v: &mut Value, k: &str) {
    if let Some(o) = v.as_object_mut() {
        o.remove(k);
    }
}
fn session(a: &Actor) -> Result<(), StoreError> {
    if matches!(a.authentication, Authentication::Session { .. }) && a.scopes.is_none() {
        Ok(())
    } else {
        Err(StoreError::Forbidden)
    }
}
fn request(a: &Actor, v: Value, kind: &str) -> Result<Value, StoreError> {
    session(a)?;
    let v = contract::request(v, kind).map_err(|_| StoreError::InvalidInput)?;
    if v["workspaceId"] != a.workspace_id
        || !matches!(&a.authentication,Authentication::Session{session_id} if v["sessionId"] == *session_id)
    {
        return Err(StoreError::Forbidden);
    }
    Ok(v)
}
async fn fence(c: &mut PgConnection, a: &Actor) -> Result<(), StoreError> {
    sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
        .bind(&a.workspace_id)
        .fetch_optional(c)
        .await?
        .ok_or(StoreError::Forbidden)?;
    Ok(())
}
async fn modules(
    c: &mut PgConnection,
    a: &Actor,
    options: ImportOptions,
) -> Result<Modules, StoreError> {
    let mut m = options.modules;
    m.initiatives = crate::initiatives::settings(
        c,
        a,
        crate::initiatives::InitiativeOptions {
            enabled: m.initiatives,
        },
    )
    .await?["settings"]["enabled"]
        == true;
    Ok(m)
}
fn require_module(e: &Value, m: Modules) -> Result<(), StoreError> {
    if match text(e, "kind") {
        "issue" | "project" => true,
        "initiative" => m.initiatives,
        "document" => m.documents,
        "view" => m.views,
        "resource" => m.resources,
        "milestone" => m.milestones,
        _ => false,
    } {
        Ok(())
    } else {
        Err(StoreError::Forbidden)
    }
}
async fn authorize(
    c: &mut PgConnection,
    a: &Actor,
    m: &Value,
    options: ImportOptions,
) -> Result<(), StoreError> {
    session(a)?;
    if m["version"] != 1
        || m["policyVersion"] != 1
        || m["actorId"] != a.user_id
        || m["workspaceId"] != a.workspace_id
    {
        return Err(StoreError::Forbidden);
    }
    let enabled = modules(c, a, options).await?;
    let mut teams = HashSet::new();
    for e in array(m, "entries") {
        require_module(e, enabled)?;
        if let Some(ids) = e
            .get("teamIds")
            .or_else(|| e["project"].get("teamIds"))
            .and_then(Value::as_array)
        {
            for id in ids {
                teams.insert(
                    id.as_str()
                        .unwrap_or_default()
                        .parse::<Uuid>()
                        .map_err(|_| StoreError::InvalidInput)?,
                );
            }
        } else if let Ok(team) = text(e, "teamId").parse::<Uuid>() {
            teams.insert(team);
        }
    }
    // Deterministic lock order across previews and execution.
    let mut teams: Vec<_> = teams.into_iter().collect();
    teams.sort();
    for team in teams {
        policy::team(c, a, team).await?;
    }
    Ok(())
}
fn backup_key(m: &Value, index: usize) -> String {
    format!("forge:legacy-conflict:v1:import-{}-{index}", text(m, "id"))
}
fn default_status() -> String {
    forge_core::definitions::DefinitionValue::defaults().as_value()["statuses"]["defaultId"]
        .as_str()
        .unwrap()
        .into()
}
fn build(
    a: &Actor,
    sources: &[Source],
    id: &str,
    modules: Option<Modules>,
    created_at: &str,
) -> Result<Value, StoreError> {
    contract::build(
        id,
        &a.user_id,
        &a.workspace_id,
        sources,
        &default_status(),
        modules,
        created_at,
    )
    .map_err(|_| StoreError::Planning("The legacy source inventory could not be read."))
}
async fn backup(
    c: &mut PgConnection,
    a: &Actor,
    m: &Value,
    index: usize,
    lock: bool,
) -> Result<Option<Source>, StoreError> {
    let q = format!(
        "SELECT encoded_value FROM product_state WHERE workspace_id=$1 AND owner_id=$2 AND key=$3 {}",
        if lock { "FOR SHARE" } else { "" }
    );
    let encoded: Option<Option<String>> = sqlx::query_scalar(&q)
        .bind(&a.workspace_id)
        .bind(format!("user:{}", a.user_id))
        .bind(backup_key(m, index))
        .fetch_optional(c)
        .await?;
    let preserved = encoded
        .flatten()
        .and_then(|s| serde_json::from_str::<String>(&s).ok())
        .and_then(|s| forge_core::json::parse(&s).ok());
    Ok(preserved.and_then(|v| {
        let s = &m["sources"][index];
        let raw = v["value"].as_str()?;
        (v["key"] == s["key"] && hash(&json!(raw)) == s["checksum"]).then(|| Source {
            key: text(s, "key").into(),
            raw: raw.into(),
        })
    }))
}
async fn hydrate(
    c: &mut PgConnection,
    a: &Actor,
    m: &mut Value,
    options: ImportOptions,
) -> Result<(), StoreError> {
    let mut sources = vec![];
    for index in 0..array(m, "sources").len() {
        if let Some(s) = backup(c, a, m, index, false).await? {
            sources.push(s);
        }
    }
    let enabled = if m["contentVersion"] == 2 {
        Some(serde_json::from_value(m["modules"].clone()).map_err(|_| StoreError::InvalidInput)?)
    } else {
        None
    };
    let payload = build(a, &sources, text(m, "id"), enabled, text(m, "createdAt"))?;
    let originals: HashMap<_, _> = array(&payload, "entries")
        .iter()
        .map(|e| (text(e, "id"), e))
        .collect();
    let mut entries = array(m, "entries").to_vec();
    let recorded: HashSet<String> = entries.iter().map(|e| text(e, "id").into()).collect();
    entries.extend(
        array(&payload, "entries")
            .iter()
            .filter(|e| e["canonicalProjection"] == true && !recorded.contains(text(e, "id")))
            .cloned(),
    );
    for e in &mut entries {
        let original = originals.get(text(e, "id"));
        e["title"] = original.map_or(json!("Unavailable source record"), |v| v["title"].clone());
        if e["conflict"].is_object() {
            let mut candidates = array(&e["conflict"], "candidates").to_vec();
            for candidate in &mut candidates {
                let live = target(c, a, e, text(candidate, "id"), false, options).await?;
                candidate["title"] = live
                    .as_ref()
                    .map_or(json!("Unavailable shared record"), |v| v["title"].clone());
                if let Some(live) = live {
                    candidate["details"] = live["details"].clone();
                } else {
                    remove(candidate, "details");
                }
                candidate["canMigrateFiles"] =
                    json!(conversion_available(c, a, e, text(candidate, "id")).await?);
            }
            e["conflict"]["candidates"] = json!(candidates);
        }
        if let Some(original) = original {
            for k in [
                "sourceChecksum",
                "sourceValid",
                "draft",
                "project",
                "content",
            ] {
                if let Some(v) = original.get(k) {
                    e[k] = v.clone();
                } else {
                    remove(e, k);
                }
            }
            for (i, f) in e["files"].as_array_mut().into_iter().flatten().enumerate() {
                f["data"] = if forge_core::comments::truthy(&f["fileId"]) {
                    json!("")
                } else {
                    original["files"][i]
                        .get("data")
                        .cloned()
                        .unwrap_or(json!(""))
                };
            }
        } else if e["state"] != "saved" && e["state"] != "skipped" {
            e["state"] = json!("quarantined");
            e["sourceValid"] = json!(false);
            e["message"] =
                json!("The original source is no longer available. No new effect can run.");
        }
    }
    let mut errors = array(&payload, "sourceErrors").to_vec();
    if sources.len() != array(m, "sources").len() {
        errors.push(json!(
            "A private source backup is missing or its checksum differs."
        ));
    }
    if entries.len() != originals.len()
        || entries
            .iter()
            .any(|e| !originals.contains_key(text(e, "id")))
    {
        errors.push(json!(
            "Source and manifest record counts or identities differ."
        ));
    }
    m["entries"] = json!(entries);
    m["sourceErrors"] = json!(errors);
    for s in m["sources"].as_array_mut().into_iter().flatten() {
        s["raw"] = json!("");
    }
    Ok(())
}
async fn load(
    c: &mut PgConnection,
    a: &Actor,
    id: Uuid,
    lock: bool,
    options: ImportOptions,
) -> Result<Value, StoreError> {
    let q = format!(
        "SELECT encoded_manifest FROM legacy_imports WHERE id=$1 AND workspace_id=$2 AND user_id=$3 {}",
        if lock { "FOR UPDATE" } else { "" }
    );
    let encoded: String = sqlx::query_scalar(&q)
        .bind(id)
        .bind(&a.workspace_id)
        .bind(&a.user_id)
        .fetch_optional(&mut *c)
        .await?
        .ok_or(StoreError::Forbidden)?;
    let mut m = forge_core::json::parse(&encoded).map_err(|_| StoreError::InvalidInput)?;
    authorize(c, a, &m, options).await?;
    hydrate(c, a, &mut m, options).await?;
    authorize(c, a, &m, options).await?;
    Ok(m)
}
async fn save(c: &mut PgConnection, m: &mut Value) -> Result<(), StoreError> {
    let revision = m["revision"]
        .as_i64()
        .and_then(|r| r.checked_add(1))
        .and_then(|r| i32::try_from(r).ok())
        .ok_or(StoreError::InvalidInput)?;
    m["revision"] = json!(revision);
    sqlx::query("UPDATE legacy_imports SET revision=$1,encoded_manifest=$2 WHERE id=$3")
        .bind(revision)
        .bind(checkpoint::encode(m))
        .bind(id(m, "id")?)
        .execute(c)
        .await?;
    Ok(())
}
pub async fn prepare(
    db: &Database,
    a: &Actor,
    input: Value,
    options: ImportOptions,
) -> Result<Value, StoreError> {
    request(a, input, "identity")?;
    let mut tx = db.begin().await?;
    let a = current_actor(&mut tx, a).await?;
    fence(&mut tx, &a).await?;
    let teams = policy::team_ids(&mut tx, &a).await?;
    let mut keys: HashSet<String> = teams
        .iter()
        .flat_map(|t| {
            [
                format!("forge:team-issues:v1:{t}"),
                format!("forge:triage-issues:v1:{t}"),
                format!("forge:cycle-issues:v1:{t}"),
                format!("forge:team-home:v1:{t}"),
            ]
        })
        .collect();
    keys.insert(format!("forge:workspace:{}:initiatives:v1", a.workspace_id));
    keys.insert(format!(
        "forge:workspace:{}:custom-views:v1:{}",
        a.workspace_id, a.user_id
    ));
    let enabled = modules(&mut tx, &a, options).await?;
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT key,encoded_value FROM product_state WHERE workspace_id=$1 AND owner_id=$2",
    )
    .bind(&a.workspace_id)
    .bind(format!("user:{}", a.user_id))
    .fetch_all(&mut *tx)
    .await?;
    let current_keys: HashSet<_> = rows
        .iter()
        .filter(|(k, v)| keys.contains(k) && v.is_some())
        .map(|(k, _)| k.as_str())
        .collect();
    let mut sources = vec![];
    let mut retained = vec![];
    for (key, encoded) in &rows {
        let Some(encoded) = encoded else { continue };
        if keys.contains(key) {
            sources.push(Source {
                key: key.clone(),
                raw: serde_json::from_str(encoded).map_err(|_| StoreError::InvalidInput)?,
            });
        } else if key.starts_with("forge:legacy-conflict:v1:")
            && let Ok(raw) = serde_json::from_str::<String>(encoded)
            && let Ok(v) = forge_core::json::parse(&raw)
            && keys.contains(text(&v, "key"))
            && let Some(raw) = v["value"].as_str()
        {
            let source = Source {
                key: text(&v, "key").into(),
                raw: raw.into(),
            };
            if key.starts_with("forge:legacy-conflict:v1:import-") {
                retained.push((key.clone(), source));
            } else {
                sources.push(source);
            }
        }
    }
    let encoded: Vec<String> = sqlx::query_scalar(
        "SELECT encoded_manifest FROM legacy_imports WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(&a.workspace_id)
    .bind(&a.user_id)
    .fetch_all(&mut *tx)
    .await?;
    let completed = encoded
        .iter()
        .map(|s| forge_core::json::parse(s).map_err(|_| StoreError::InvalidInput))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|m| forge_core::comments::truthy(&m["completedAt"]))
        .collect::<Vec<_>>();
    let completed_keys: HashSet<_> = completed
        .iter()
        .flat_map(|m| (0..array(m, "sources").len()).map(move |i| backup_key(m, i)))
        .collect();
    for (key, s) in retained {
        if !current_keys.contains(s.key.as_str()) && completed_keys.contains(&key) {
            sources.push(s);
        }
    }
    let settled: HashSet<_> = completed
        .iter()
        .filter(|m| m["contentVersion"] == 2 && hash(&m["modules"]) == hash(&json!(enabled)))
        .flat_map(|m| array(m, "sources").iter().chain(array(m, "cleanedSources")))
        .map(|s| javascript_stringify(&json!([s["key"], s["checksum"]])))
        .collect();
    sources
        .retain(|s| !settled.contains(&javascript_stringify(&json!([s.key, hash(&json!(s.raw))]))));
    if sources.is_empty() {
        tx.commit().await?;
        return Ok(Value::Null);
    }
    let references: Vec<_> = completed
        .iter()
        .flat_map(|m| {
            array(m, "entries")
                .iter()
                .filter(|e| {
                    e["state"] == "saved" && forge_core::comments::truthy(&e["canonicalId"])
                })
                .map(|e| {
                    let mut r = json!({"manifestId":m["id"],"state":"saved"});
                    for k in [
                        "id",
                        "sourceKey",
                        "sourceChecksum",
                        "legacyId",
                        "legacyAliases",
                        "kind",
                        "teamId",
                        "canonicalId",
                    ] {
                        if let Some(v) = e.get(k) {
                            r[k] = v.clone();
                        }
                    }
                    r
                })
        })
        .collect();
    let mut m = build(
        &a,
        &sources,
        &Uuid::new_v4().to_string(),
        Some(enabled),
        &now(),
    )?;
    m["referenceContext"] = json!(references);
    if array(&m, "entries").is_empty() && array(&m, "exclusions").is_empty() {
        tx.commit().await?;
        return Ok(Value::Null);
    }
    authorize(&mut tx, &a, &m, options).await?;
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM legacy_imports WHERE workspace_id=$1 AND user_id=$2 AND fingerprint=$3",
    )
    .bind(&a.workspace_id)
    .bind(&a.user_id)
    .bind(text(&m, "fingerprint"))
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(existing) = existing {
        let mut prior = load(&mut tx, &a, existing, true, options).await?;
        if !forge_core::comments::truthy(&prior["completedAt"])
            && hash(&prior.get("referenceContext").cloned().unwrap_or(json!([])))
                != hash(&json!(references))
        {
            prior["referenceContext"] = json!(references);
            tx.prepare().await?;
            save(&mut tx, &mut prior).await?;
        }
        tx.commit().await?;
        return Ok(checkpoint::snapshot(&prior, false));
    }
    tx.prepare().await?;
    for (index, s) in array(&m, "sources").iter().enumerate() {
        let raw = javascript_stringify(
            &json!({"key":s["key"],"value":s["raw"],"reason":"Import source snapshot","createdAt":m["createdAt"]}),
        );
        sqlx::query("INSERT INTO product_state(workspace_id,owner_id,owner_user_id,key,encoded_value) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING").bind(&a.workspace_id).bind(format!("user:{}",a.user_id)).bind(&a.user_id).bind(backup_key(&m,index)).bind(javascript_stringify(&json!(raw))).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO legacy_imports(id,workspace_id,user_id,fingerprint,encoded_manifest) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING").bind(id(&m,"id")?).bind(&a.workspace_id).bind(&a.user_id).bind(text(&m,"fingerprint")).bind(checkpoint::encode(&m)).execute(&mut *tx).await?;
    let saved: Uuid = sqlx::query_scalar(
        "SELECT id FROM legacy_imports WHERE workspace_id=$1 AND user_id=$2 AND fingerprint=$3",
    )
    .bind(&a.workspace_id)
    .bind(&a.user_id)
    .bind(text(&m, "fingerprint"))
    .fetch_one(&mut *tx)
    .await?;
    let m = load(&mut tx, &a, saved, true, options).await?;
    tx.commit().await?;
    Ok(checkpoint::snapshot(&m, false))
}
pub async fn read(
    db: &Database,
    a: &Actor,
    input: Value,
    options: ImportOptions,
) -> Result<Value, StoreError> {
    request(a, input, "identity")?;
    let mut tx = db.begin().await?;
    let a = current_actor(&mut tx, a).await?;
    let ids:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM legacy_imports WHERE workspace_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 20").bind(&a.workspace_id).bind(&a.user_id).fetch_all(&mut *tx).await?;
    let mut values = vec![];
    for id in ids {
        match load(&mut tx, &a, id, true, options).await {
            Ok(m) => values.push(checkpoint::snapshot(&m, false)),
            Err(StoreError::Forbidden) => {}
            Err(e) => return Err(e),
        }
    }
    tx.commit().await?;
    Ok(json!(values))
}
