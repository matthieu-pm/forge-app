use super::*;
use crate::commands::{self, Command, CommandHandler, CommandResult, OutboxEvent};
use async_trait::async_trait;
use execution::{Saved, graph, reread, result};
pub(super) async fn report(
    c: &mut PgConnection,
    a: &Actor,
    m: &Value,
    full: bool,
    options: ImportOptions,
) -> Result<Value, StoreError> {
    let mut discrepancies: Vec<_> = array(m, "sourceErrors")
        .iter()
        .map(|message| json!({"message":message}))
        .collect();
    let (mut saved, mut skipped, mut unresolved, mut files, mut verified) = (0, 0, 0, 0, 0);
    for i in 0..array(m, "sources").len() {
        if backup(c, a, m, i, true).await?.is_none() {
            discrepancies.push(
                json!({"message":"A private source backup is missing or its checksum differs."}),
            );
        }
    }
    let mut observed = vec![];
    for e in checkpoint::ordered_entries(m) {
        let mut fail =
            |message: Value| discrepancies.push(json!({"entryId":e["id"],"message":message}));
        if e["state"] == "skipped" {
            skipped += 1;
            continue;
        }
        if e["state"] != "saved" || text(e, "canonicalId").is_empty() {
            unresolved += 1;
            fail(
                e.get("message")
                    .cloned()
                    .unwrap_or(json!("A source record still needs import or review.")),
            );
            continue;
        }
        saved += 1;
        let live = target(c, a, e, text(e, "canonicalId"), true, options).await?;
        observed.push(json!([e["id"], live.as_ref().map(|v| &v["fingerprint"])]));
        let expected = if let Some(fp) = e.get("targetFingerprint").filter(|v| !v.is_null()) {
            fp.clone()
        } else {
            review::aliases(c, a, e)
                .await?
                .iter()
                .find(|r| {
                    r["fingerprint"] == e["fingerprint"] && r["canonicalId"] == e["canonicalId"]
                })
                .map_or(Value::Null, |r| r["targetFingerprint"].clone())
        };
        if live
            .as_ref()
            .is_none_or(|v| expected.is_null() || v["fingerprint"] != expected)
        {
            fail(json!(
                "The shared record changed or is unavailable. Retry unresolved records to review the current version."
            ));
        }
        if e["kind"] == "issue"
            && let Some(live) = &live
            && e["decision"]["choice"] != "keep-server"
            && e["replaceLegacyFiles"] != true
        {
            let mut entry = e.clone();
            entry["canonicalProjection"] = json!(false);
            if !entry["draft"].is_object() {
                entry["draft"] = json!({});
            }
            match review::mapping(c, a, m, &entry, options).await {
                Ok(Some(mapping)) => {
                    if !review::mapping_matches(&mapping, live) {
                        fail(json!(
                            "Canonical parent or project relationships differ from the source mapping."
                        ));
                    }
                }
                Ok(None) => {}
                Err(_) => fail(json!(
                    "A source relationship is missing, ambiguous or unavailable."
                )),
            }
        }
        if e["content"].is_object() && e["decision"]["choice"] != "keep-server" {
            match references::relationships(c, a, m, e, text(e, "canonicalId"), options).await {
                Ok(true) => {}
                Ok(false) => fail(json!(
                    "Canonical content relationships differ from the source mapping."
                )),
                Err(_) => fail(json!(
                    "A content relationship is missing, ambiguous or unavailable."
                )),
            }
        }
        for file in array(e, "files") {
            files += 1;
            if text(file, "fileId").is_empty() {
                fail(json!("A source file has not been verified and attached."));
                continue;
            }
            let bound:Option<Value>=sqlx::query_scalar("SELECT to_jsonb(f) FROM resource_files f WHERE workspace_id=$1 AND id=$2 FOR SHARE").bind(&a.workspace_id).bind(id(file,"fileId")?).fetch_optional(&mut *c).await?;
            let bound = bound.unwrap_or(Value::Null);
            let deleted = if let Some(date) = bound["deleted_at"].as_str() {
                json!(
                    chrono::DateTime::parse_from_rfc3339(date)
                        .map_err(|_| StoreError::InvalidInput)?
                        .with_timezone(&Utc)
                        .to_rfc3339_opts(SecondsFormat::Millis, true)
                )
            } else {
                Value::Null
            };
            observed.push(json!([
                file["fileId"],
                bound["checksum"],
                bound["attachment_state"],
                deleted
            ]));
            let props: Option<Value> =
                sqlx::query_scalar("SELECT properties FROM issues WHERE workspace_id=$1 AND id=$2")
                    .bind(&a.workspace_id)
                    .bind(id(e, "canonicalId")?)
                    .fetch_optional(&mut *c)
                    .await?;
            let matches = props.is_some_and(|p| {
                array(&p, "attachments").iter().any(|f| {
                    f["fileId"] == file["fileId"]
                        && f["checksum"] == file["checksum"]
                        && f["sizeBytes"] == file["sizeBytes"]
                        && !forge_core::comments::truthy(&f["data"])
                })
            });
            if bound.is_null()
                || bound["issue_id"] != e["canonicalId"]
                || !bound["deleted_at"].is_null()
                || bound["attachment_state"] != "attached"
                || !bound["comment_id"].is_null()
                || bound["checksum"] != file["checksum"]
                || bound["size_bytes"] != file["sizeBytes"]
                || bound["name"] != file["name"]
                || !matches
            {
                fail(json!(
                    "An attached file is missing or differs from its verified source checksum."
                ));
            } else {
                verified += 1;
            }
        }
    }
    let counts = json!({"sources":array(m,"sources").len(),"records":array(m,"entries").len(),"saved":saved,"skipped":skipped,"unresolved":unresolved,"files":files,"verifiedFiles":verified});
    let fingerprint = hash(
        &json!({"manifest":m["fingerprint"],"counts":counts,"discrepancies":discrepancies,"observed":observed,"exclusions":m["exclusions"]}),
    );
    Ok(
        json!({"fingerprint":fingerprint,"checkedAt":now(),"ready":discrepancies.is_empty(),"counts":counts,"discrepancyCount":discrepancies.len(),"discrepancies":if full{&discrepancies[..]}else{&discrepancies[..discrepancies.len().min(100)]},"retainedExclusions":array(m,"exclusions").len()+skipped as usize}),
    )
}
pub async fn retry(
    db: &Database,
    a: &Actor,
    input: Value,
    options: ImportOptions,
) -> Result<Value, StoreError> {
    let input = request(a, input, "request")?;
    let mut tx = db.begin().await?;
    let a = current_actor(&mut tx, a).await?;
    graph(&mut tx, &a).await?;
    let mut m = load(&mut tx, &a, id(&input, "id")?, true, options).await?;
    if m["revision"] != input["revision"] {
        return Err(StoreError::Planning(
            "Import progress changed. Refresh before retrying.",
        ));
    }
    if forge_core::comments::truthy(&m["cleanedAt"]) {
        return Err(StoreError::Planning(
            "This import is completed and cleaned. New source data requires a new import.",
        ));
    }
    remove(&mut m, "completedAt");
    remove(&mut m, "reconciliation");
    let report = report(&mut tx, &a, &m, true, options).await?;
    let failed: HashSet<_> = array(&report, "discrepancies")
        .iter()
        .filter_map(|d| d["entryId"].as_str())
        .collect();
    for e in m["entries"]
        .as_array_mut()
        .ok_or(StoreError::InvalidInput)?
    {
        if e["state"] == "saved" && failed.contains(text(e, "id")) {
            e["state"] = json!("pending");
            e["reviewRequired"] = json!(true);
            remove(e, "decision");
        }
        if e["state"] == "quarantined"
            && e["sourceValid"] == true
            && ["draft", "project", "content"]
                .iter()
                .any(|k| e[*k].is_object())
        {
            e["state"] = json!("pending");
            remove(e, "message");
        }
        for f in e["files"].as_array_mut().into_iter().flatten() {
            if text(f, "fileId").is_empty() {
                f["attempt"] = json!(
                    f["attempt"]
                        .as_i64()
                        .unwrap_or(0)
                        .checked_add(1)
                        .ok_or(StoreError::InvalidInput)?
                );
            }
        }
    }
    tx.prepare().await?;
    save(&mut tx, &mut m).await?;
    tx.commit().await?;
    Ok(checkpoint::snapshot(&m, false))
}
struct Cutover<'a> {
    input: &'a Value,
    options: ImportOptions,
}
#[async_trait]
impl CommandHandler for Cutover<'_> {
    type Output = Saved;
    async fn authorize(
        &self,
        c: &mut PgConnection,
        a: &Actor,
        _: Option<&Saved>,
    ) -> Result<(), StoreError> {
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
        if m["revision"] != self.input["revision"] {
            return Err(StoreError::Planning(
                "Import progress changed. Refresh and reconcile again.",
            ));
        }
        let report = report(c, a, &m, false, self.options).await?;
        if self.input["action"] != "reconcile" {
            if report["ready"] != true {
                return Err(StoreError::Planning(
                    "Unresolved discrepancies block completion and cleanup. Reconcile and review the report.",
                ));
            }
            if self.input["reportFingerprint"] != report["fingerprint"] {
                return Err(StoreError::Planning(
                    "Reconciliation changed. Check the latest report before continuing.",
                ));
            }
            if report["retainedExclusions"].as_u64().unwrap_or(0) > 0
                && self.input["acknowledgeExclusions"] != true
            {
                return Err(StoreError::Planning(
                    "Acknowledge the excluded and skipped data retained in your private backups.",
                ));
            }
            if m["completedAt"].is_null() {
                m["completedAt"] = json!(now());
            }
        }
        if self.input["action"] == "cleanup" && !forge_core::comments::truthy(&m["cleanedAt"]) {
            let mut cleaned_sources = vec![];
            for source in array(&m, "sources") {
                let key = text(source, "key");
                if ![
                    "forge:team-issues:v1:",
                    "forge:triage-issues:v1:",
                    "forge:cycle-issues:v1:",
                ]
                .iter()
                .any(|prefix| key.starts_with(prefix))
                {
                    continue;
                }
                let row:Option<(Option<String>,i32)>=sqlx::query_as("SELECT encoded_value,revision FROM product_state WHERE workspace_id=$1 AND owner_id=$2 AND key=$3 FOR UPDATE").bind(&a.workspace_id).bind(format!("user:{}",a.user_id)).bind(key).fetch_optional(&mut *c).await?;
                let Some((Some(encoded), revision)) = row else {
                    continue;
                };
                let raw: String =
                    serde_json::from_str(&encoded).map_err(|_| StoreError::InvalidInput)?;
                if hash(&json!(raw)) != source["checksum"] {
                    continue;
                }
                let mut body =
                    forge_core::json::parse(&raw).map_err(|_| StoreError::InvalidInput)?;
                if let Some(team) = key.strip_prefix("forge:team-issues:v1:") {
                    let favorites: Vec<_> = array(&m, "entries")
                        .iter()
                        .filter(|e| {
                            e["sourceKey"] == source["key"]
                                && e["sourceChecksum"] == source["checksum"]
                                && e["draft"]["favorite"] == true
                                && forge_core::comments::truthy(&e["canonicalId"])
                        })
                        .map(|e| e["canonicalId"].clone())
                        .collect();
                    let encoded =
                        javascript_stringify(&json!(javascript_stringify(&json!(favorites))));
                    sqlx::query("INSERT INTO product_state(workspace_id,owner_id,owner_user_id,team_id,key,encoded_value) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING").bind(&a.workspace_id).bind(format!("user:{}",a.user_id)).bind(&a.user_id).bind(team.parse::<Uuid>().map_err(|_|StoreError::InvalidInput)?).bind(format!("forge:team-issue-favorites:v1:{team}")).bind(encoded).execute(&mut *c).await?;
                }
                if body.is_array() {
                    body = json!([]);
                } else {
                    body["issues"] = json!([]);
                }
                let cleaned = javascript_stringify(&body);
                sqlx::query("UPDATE product_state SET encoded_value=$1,revision=$2 WHERE workspace_id=$3 AND owner_id=$4 AND key=$5").bind(javascript_stringify(&json!(cleaned))).bind(revision.checked_add(1).ok_or(StoreError::InvalidInput)?).bind(&a.workspace_id).bind(format!("user:{}",a.user_id)).bind(key).execute(&mut *c).await?;
                cleaned_sources.push(json!({"key":key,"checksum":hash(&json!(cleaned))}));
            }
            m["cleanedSources"] = json!(cleaned_sources);
            m["cleanedAt"] = json!(now());
        }
        m["reconciliation"] = report.clone();
        save(c, &mut m).await?;
        Ok(result(&m,vec![OutboxEvent{topic:"imports.reconciled".into(),payload:json!({"importId":m["id"],"action":self.input["action"],"ready":report["ready"]}).as_object().unwrap().clone()}]))
    }
}
pub async fn cutover(
    db: &Database,
    a: &Actor,
    input: Value,
    options: ImportOptions,
) -> Result<Value, StoreError> {
    let input = request(a, input, "cutover")?;
    let key = format!(
        "import-cutover:{}:{}:{}",
        text(&input, "id"),
        input["revision"],
        text(&input, "action")
    );
    let body = json!({"id":input["id"],"revision":input["revision"],"action":input["action"],"reportFingerprint":input["reportFingerprint"],"acknowledgeExclusions":input["acknowledgeExclusions"]});
    commands::execute(
        db,
        a,
        Command {
            key: &key,
            operation: "imports.cutover@1",
            input: &body,
            status: 200,
        },
        &Cutover {
            input: &input,
            options,
        },
    )
    .await?;
    reread(db, a, id(&input, "id")?, options).await
}
pub async fn download_report(
    db: &Database,
    a: &Actor,
    input: Value,
    options: ImportOptions,
) -> Result<Value, StoreError> {
    let input = request(a, input, "request")?;
    let mut tx = db.begin().await?;
    let a = current_actor(&mut tx, a).await?;
    graph(&mut tx, &a).await?;
    let m = load(&mut tx, &a, id(&input, "id")?, true, options).await?;
    let report = report(&mut tx, &a, &m, true, options).await?;
    let mut output = json!({"version":1,"id":m["id"],"workspaceId":a.workspace_id,"actorId":a.user_id,"authority":"canonical-server","report":report,"sources":array(&m,"sources").iter().map(|s|json!({"key":s["key"],"checksum":s["checksum"]})).collect::<Vec<_>>(),"exclusions":m["exclusions"]});
    for k in ["completedAt", "cleanedAt"] {
        if let Some(v) = m.get(k) {
            output[k] = v.clone();
        }
    }
    output["records"] = json!(
        array(&m, "entries")
            .iter()
            .map(|e| {
                let mut r = json!({});
                for k in [
                    "id",
                    "sourceKey",
                    "path",
                    "legacyId",
                    "canonicalId",
                    "state",
                ] {
                    if let Some(v) = e.get(k) {
                        r[k] = v.clone();
                    }
                }
                r
            })
            .collect::<Vec<_>>()
    );
    tx.commit().await?;
    Ok(output)
}
