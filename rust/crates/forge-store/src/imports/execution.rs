use super::*;
use crate::commands::{self, Command, CommandHandler, CommandResult, OutboxEvent};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Saved {
    #[serde(deserialize_with = "saved_id")]
    pub id: String,
}
fn saved_id<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let s = String::deserialize(d)?;
    if forge_core::text::is_uuid(&s) {
        Ok(s)
    } else {
        Err(serde::de::Error::custom("import receipt UUID"))
    }
}
pub(super) fn result(m: &Value, events: Vec<OutboxEvent>) -> CommandResult<Saved> {
    CommandResult {
        value: Saved {
            id: text(m, "id").into(),
        },
        resource_type: "legacyImport".into(),
        resource_id: text(m, "id").into(),
        events,
    }
}
pub(super) async fn graph(c: &mut PgConnection, a: &Actor) -> Result<(), StoreError> {
    fence(c, a).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,4040))")
        .bind(&a.workspace_id)
        .execute(&mut *c)
        .await?;
    sqlx::query("SELECT public.forge_lock_issue_graph($1)")
        .bind(&a.workspace_id)
        .execute(c)
        .await?;
    Ok(())
}
struct Effect {
    events: Vec<OutboxEvent>,
    parents: Vec<(usize, Value)>,
    exclusion: Option<Value>,
}
async fn apply(
    c: &mut PgConnection,
    a: &Actor,
    m: &Value,
    e: &mut Value,
    options: ImportOptions,
) -> Result<Effect, StoreError> {
    if e["sourceValid"] != true {
        return Err(StoreError::Planning(
            "The source record is invalid. Correct its retained source before importing.",
        ));
    }
    require_module(e, modules(c, a, options).await?)?;
    let mut effect = Effect {
        events: vec![],
        parents: vec![],
        exclusion: None,
    };
    match review::reconcile(c, a, m, e, options).await? {
        review::Decision::Blocked => return Ok(effect),
        review::Decision::Skip => {
            e["state"] = json!("skipped");
            return Ok(effect);
        }
        review::Decision::Convert(uid) => {
            e["canonicalId"] = json!(uid);
            e["replaceLegacyFiles"] = json!(true);
            e["state"] = json!("saved");
            remove(e, "reviewRequired");
            review::record_alias(c, a, e, &uid, options).await?;
        }
        review::Decision::Reuse { id: uid, reviewed } => {
            e["canonicalId"] = json!(uid);
            e["state"] = json!("saved");
            remove(e, "reviewRequired");
            if reviewed {
                e["message"] = json!(
                    "Kept the existing shared record. This source version and its files remain in your private backup."
                );
                effect.exclusion = Some(json!(format!(
                    "{}/{}: kept the reviewed shared version; source fields/files were not added.",
                    text(e, "sourceKey"),
                    text(e, "path")
                )));
                e["files"] = json!([]);
            } else if !array(e, "files").is_empty() {
                let row = targets::raw(
                    c,
                    a,
                    "issue",
                    uid.parse().map_err(|_| StoreError::InvalidInput)?,
                    false,
                )
                .await?
                .ok_or(StoreError::Forbidden)?;
                for source in e["files"].as_array_mut().ok_or(StoreError::InvalidInput)? {
                    source["data"] = json!("");
                    let matching = array(&row["properties"], "attachments").iter().find(|f| {
                        forge_core::comments::truthy(&f["fileId"])
                            && ["name", "checksum", "sizeBytes"]
                                .iter()
                                .all(|k| f[*k] == source[*k])
                    });
                    if let Some(f) = matching {
                        source["fileId"] = f["fileId"].clone();
                    } else {
                        remove(source, "fileId");
                    }
                }
            }
        }
        review::Decision::New { both } => {
            if forge_core::comments::truthy(&e["canonicalId"]) {
                let mut files = contract::validated_files(array(&e["draft"], "attachments"))
                    .map_err(|_| StoreError::Planning("The original source files are invalid."))?;
                for (i, f) in files.iter_mut().enumerate() {
                    f["attempt"] = json!(
                        e["files"][i]["attempt"]
                            .as_i64()
                            .unwrap_or(0)
                            .checked_add(1)
                            .ok_or(StoreError::InvalidInput)?
                    );
                }
                e["files"] = json!(files);
                e["replaceLegacyFiles"] = json!(false);
            }
            let created = create::create(c, a, m, e, both, options).await?;
            e["canonicalId"] = json!(created.id);
            effect.events = created.events;
            if let Some(project) = created.changed_project {
                for (i, parent) in array(m, "entries").iter().enumerate().filter(|(_, p)| {
                    p["kind"] == "project" && p["state"] == "saved" && p["canonicalId"] == project
                }) {
                    let mut parent = parent.clone();
                    let live = target(c, a, &parent, &project, false, options)
                        .await?
                        .ok_or(StoreError::Forbidden)?;
                    parent["targetFingerprint"] = live["fingerprint"].clone();
                    review::record_alias(c, a, &parent, &project, options).await?;
                    effect.parents.push((i, parent));
                }
            }
            e["state"] = json!("saved");
            remove(e, "reviewRequired");
            remove(e, "message");
            if e["kind"] == "issue" {
                effect.events.push(OutboxEvent{topic:"issue.created".into(),payload:json!({"issueId":e["canonicalId"],"teamId":e["teamId"],"history":{"version":1,"origin":"import"}}).as_object().unwrap().clone()});
            }
        }
    }
    e["targetFingerprint"] = target(c, a, e, text(e, "canonicalId"), false, options)
        .await?
        .ok_or(StoreError::Forbidden)?["fingerprint"]
        .clone();
    Ok(effect)
}
fn eligible(m: &Value, e: &Value) -> bool {
    if e["kind"] == "project" {
        return true;
    }
    let mut dependencies = checkpoint::content_dependencies(e);
    if m["modules"]["milestones"] == true && !text(&e["draft"], "milestone").is_empty() {
        dependencies.push((
            "milestone".into(),
            format!(
                "{}::{}",
                text(&e["draft"], "project"),
                text(&e["draft"], "milestone")
            ),
        ));
    }
    dependencies.push(("issue".into(), text(&e["draft"], "parentId").into()));
    dependencies.push(("project".into(), text(&e["draft"], "project").into()));
    dependencies.iter().all(|(kind, legacy)| {
        checkpoint::references(m, e, kind, legacy)
            .iter()
            .all(|r| forge_core::comments::truthy(&r["canonicalId"]) || r["state"] == "skipped")
    })
}
struct Batch<'a> {
    input: &'a Value,
    options: ImportOptions,
}
#[async_trait]
impl CommandHandler for Batch<'_> {
    type Output = Saved;
    async fn authorize(
        &self,
        c: &mut PgConnection,
        a: &Actor,
        _: Option<&Saved>,
    ) -> Result<(), StoreError> {
        // Take the same fence before candidate locks on fresh runs and replays.
        fence(c, a).await?;
        load(c, a, id(self.input, "id")?, false, self.options).await?;
        Ok(())
    }
    async fn run(
        &self,
        c: &mut PgConnection,
        a: &Actor,
    ) -> Result<CommandResult<Saved>, StoreError> {
        graph(c, a).await?;
        let mut m = load(c, a, id(self.input, "id")?, true, self.options).await?;
        if forge_core::comments::truthy(&m["completedAt"]) {
            return Err(StoreError::Planning("This import is completed."));
        }
        if m["revision"] != self.input["revision"] {
            return Ok(result(&m, vec![]));
        }
        for e in m["entries"]
            .as_array_mut()
            .ok_or(StoreError::InvalidInput)?
        {
            if e["state"] == "waiting" {
                e["state"] = json!("pending");
            }
        }
        let mut pending: Vec<_> = array(&m, "entries")
            .iter()
            .enumerate()
            .filter(|(_, e)| e["state"] == "pending")
            .map(|(i, _)| i)
            .collect();
        pending.sort_by_key(|i| {
            let e = &m["entries"][*i];
            (
                [
                    "project",
                    "resource",
                    "milestone",
                    "initiative",
                    "document",
                    "issue",
                    "view",
                ]
                .iter()
                .position(|k| e["kind"] == *k)
                .unwrap_or(7),
                !text(&e["draft"], "parentId").is_empty(),
            )
        });
        let mut events = vec![];
        for _ in 0..10 {
            if pending.is_empty() {
                break;
            }
            let Some(position) = pending.iter().position(|i| eligible(&m, &m["entries"][*i]))
            else {
                let waiting = array(&m, "entries").iter().any(|e| e["state"] == "review");
                for i in &pending {
                    m["entries"][*i]["state"] =
                        json!(if waiting { "waiting" } else { "quarantined" });
                    m["entries"][*i]["message"] = json!(if waiting {
                        "Waiting for referenced content to be confirmed or resolved."
                    } else {
                        "Resolve the missing or circular parent/project reference, then retry unresolved records."
                    });
                }
                break;
            };
            let index = pending.remove(position);
            let mut entry = m["entries"][index].clone();
            sqlx::query("SAVEPOINT forge_import_entry")
                .execute(&mut *c)
                .await?;
            match apply(c, a, &m, &mut entry, self.options).await {
                Ok(effect) => {
                    sqlx::query("RELEASE SAVEPOINT forge_import_entry")
                        .execute(&mut *c)
                        .await?;
                    for (i, parent) in effect.parents {
                        m["entries"][i] = parent;
                    }
                    if let Some(exclusion) = effect.exclusion {
                        m["exclusions"]
                            .as_array_mut()
                            .ok_or(StoreError::InvalidInput)?
                            .push(exclusion);
                    }
                    events.extend(effect.events);
                }
                Err(error) => {
                    sqlx::query("ROLLBACK TO SAVEPOINT forge_import_entry")
                        .execute(&mut *c)
                        .await?;
                    sqlx::query("RELEASE SAVEPOINT forge_import_entry")
                        .execute(&mut *c)
                        .await?;
                    entry["state"] = json!("quarantined");
                    remove(&mut entry, "canonicalId");
                    entry["message"] = json!(match error {
                        StoreError::Forbidden => "A referenced resource is unavailable.".into(),
                        StoreError::Database(_) => "This record could not be imported.".into(),
                        _ => error.to_string(),
                    });
                }
            }
            m["entries"][index] = entry;
        }
        save(c, &mut m).await?;
        Ok(result(&m, events))
    }
}
pub(super) async fn reread(
    db: &Database,
    a: &Actor,
    uid: Uuid,
    options: ImportOptions,
) -> Result<Value, StoreError> {
    let mut tx = db.begin().await?;
    let a = current_actor(&mut tx, a).await?;
    let m = load(&mut tx, &a, uid, true, options).await?;
    tx.commit().await?;
    Ok(checkpoint::snapshot(&m, true))
}
pub async fn read_one(
    db: &Database,
    a: &Actor,
    input: Value,
    options: ImportOptions,
) -> Result<Value, StoreError> {
    let input = request(a, input, "request")?;
    reread(db, a, id(&input, "id")?, options).await
}
pub async fn batch(
    db: &Database,
    a: &Actor,
    input: Value,
    options: ImportOptions,
) -> Result<Value, StoreError> {
    let input = request(a, input, "request")?;
    let key = format!("import:{}:{}", text(&input, "id"), input["revision"]);
    let body = json!({"id":input["id"],"revision":input["revision"]});
    commands::execute(
        db,
        a,
        Command {
            key: &key,
            operation: "imports.batch@1",
            input: &body,
            status: 200,
        },
        &Batch {
            input: &input,
            options,
        },
    )
    .await?;
    reread(db, a, id(&input, "id")?, options).await
}
pub async fn choose(
    db: &Database,
    a: &Actor,
    input: Value,
    options: ImportOptions,
) -> Result<Value, StoreError> {
    let input = request(a, input, "choice")?;
    let mut tx = db.begin().await?;
    let a = current_actor(&mut tx, a).await?;
    fence(&mut tx, &a).await?;
    let mut m = load(&mut tx, &a, id(&input, "id")?, true, options).await?;
    if m["revision"] != input["revision"] {
        return Err(StoreError::Planning(
            "Import progress changed. Reload before reviewing this conflict.",
        ));
    }
    let entry = m["entries"]
        .as_array_mut()
        .ok_or(StoreError::InvalidInput)?
        .iter_mut()
        .find(|e| e["id"] == input["entryId"])
        .ok_or(StoreError::Planning("Review the current conflict first."))?;
    if entry["state"] != "review"
        || entry["conflict"]["fingerprint"] != input["conflictFingerprint"]
    {
        return Err(StoreError::Planning("Review the current conflict first."));
    }
    if entry["content"].is_object()
        && ["confirm-content", "keep-both"].contains(&text(&input, "choice"))
        && input["ownershipConfirmed"] != true
    {
        return Err(StoreError::Planning(
            "Explicit ownership and destination confirmation is required.",
        ));
    }
    entry["decision"] =
        json!({"choice":input["choice"],"fingerprint":input["conflictFingerprint"]});
    if input["ownershipConfirmed"] == true {
        entry["decision"]["ownershipConfirmed"] = json!(true);
    }
    entry["state"] = json!("pending");
    tx.prepare().await?;
    save(&mut tx, &mut m).await?;
    tx.commit().await?;
    Ok(checkpoint::snapshot(&m, false))
}
pub async fn pause(
    db: &Database,
    a: &Actor,
    input: Value,
    options: ImportOptions,
) -> Result<Value, StoreError> {
    let input = request(a, input, "request")?;
    let mut tx = db.begin().await?;
    let a = current_actor(&mut tx, a).await?;
    fence(&mut tx, &a).await?;
    let mut m = load(&mut tx, &a, id(&input, "id")?, true, options).await?;
    if m["automaticPaused"] != true {
        m["automaticPaused"] = json!(true);
        tx.prepare().await?;
        save(&mut tx, &mut m).await?;
    }
    tx.commit().await?;
    Ok(checkpoint::snapshot(&m, false))
}
