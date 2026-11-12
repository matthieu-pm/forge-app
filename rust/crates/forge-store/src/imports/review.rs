use super::*;
pub(super) enum Decision {
    New { both: bool },
    Reuse { id: String, reviewed: bool },
    Convert(String),
    Skip,
    Blocked,
}
fn alias_scope(a: &Actor, e: &Value) -> Result<(Uuid, String), StoreError> {
    let team = if e["kind"] == "milestone" || text(e, "teamId").is_empty() {
        "00000000-0000-4000-8000-000000000000"
    } else {
        text(e, "teamId")
    };
    let legacy = if e["kind"] == "view" {
        javascript_stringify(&json!([a.user_id, e["legacyId"]]))
    } else {
        text(e, "legacyId").into()
    };
    Ok((team.parse().map_err(|_| StoreError::InvalidInput)?, legacy))
}
pub(super) async fn aliases(
    c: &mut PgConnection,
    a: &Actor,
    e: &Value,
) -> Result<Vec<Value>, StoreError> {
    let (team, legacy) = alias_scope(a, e)?;
    let rows:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(r) FROM legacy_import_aliases r WHERE workspace_id=$1 AND team_id=$2 AND kind=$3 AND legacy_id=$4").bind(&a.workspace_id).bind(team).bind(text(e,"kind")).bind(legacy).fetch_all(c).await?;
    rows.into_iter()
        .map(|r| targets::row_value(r, "alias"))
        .collect()
}
pub(super) async fn record_alias(
    c: &mut PgConnection,
    a: &Actor,
    e: &Value,
    canonical: &str,
    options: ImportOptions,
) -> Result<(), StoreError> {
    let live = target(c, a, e, canonical, false, options)
        .await?
        .ok_or(StoreError::Forbidden)?;
    let (team, legacy) = alias_scope(a, e)?;
    sqlx::query("INSERT INTO legacy_import_aliases(workspace_id,team_id,kind,legacy_id,fingerprint,canonical_id,target_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,team_id,kind,legacy_id,fingerprint) DO UPDATE SET canonical_id=EXCLUDED.canonical_id,target_fingerprint=EXCLUDED.target_fingerprint").bind(&a.workspace_id).bind(team).bind(text(e,"kind")).bind(legacy).bind(text(e,"fingerprint")).bind(canonical.parse::<Uuid>().map_err(|_|StoreError::InvalidInput)?).bind(text(&live,"fingerprint")).execute(c).await?;
    Ok(())
}
pub(super) async fn advance_file_alias(
    c: &mut PgConnection,
    a: &Actor,
    e: &Value,
    previous: &str,
    next: &str,
) -> Result<(), StoreError> {
    let (team, legacy) = alias_scope(a, e)?;
    sqlx::query("UPDATE legacy_import_aliases SET target_fingerprint=$1 WHERE workspace_id=$2 AND team_id=$3 AND kind=$4 AND legacy_id=$5 AND fingerprint=$6 AND canonical_id=$7 AND target_fingerprint=$8").bind(next).bind(&a.workspace_id).bind(team).bind(text(e,"kind")).bind(legacy).bind(text(e,"fingerprint")).bind(id(e,"canonicalId")?).bind(previous).execute(c).await?;
    Ok(())
}
async fn candidates(c: &mut PgConnection, a: &Actor, e: &Value) -> Result<Vec<Uuid>, StoreError> {
    let kind = text(e, "kind");
    let (table,condition)=match kind {
        "issue"=>("issues",format!("r.team_id=$4::uuid AND {} AND (r.legacy_id=$5 OR lower(btrim(r.title))=$6 OR ($7::text<>'' AND r.properties->>'description'=$7))",policy::readable_issue(a, "r.id"))),
        "project"=>("projects",format!("{} AND (r.legacy_id=$4 OR lower(btrim(r.name))=$5)",policy::readable_project(a, "r.id"))),
        "initiative"=>("initiatives","($2::boolean OR NOT $2::boolean) AND $3::text IS NOT NULL AND r.name=$4".into()),
        "document"=>("documents",format!("{} AND (r.title=$4 OR r.id=$5)",policy::readable_document(a, "r.id"))),
        "view"=>("saved_views","($2::boolean OR NOT $2::boolean) AND r.owner_id=$3 AND r.deleted_at IS NULL AND r.definition->>'name'=$4".into()),
        _=>return Ok(vec![]),
    };
    let q = format!("SELECT r.id FROM {table} r WHERE r.workspace_id=$1 AND {condition} LIMIT 21");
    let query = sqlx::query_scalar::<_, Uuid>(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id);
    let query = match kind {
        "issue" => query
            .bind(id(e, "teamId")?)
            .bind(text(e, "legacyId"))
            .bind(forge_core::text::trim(text(e, "title")).to_lowercase())
            .bind(text(&e["draft"], "description")),
        "project" => query
            .bind(text(e, "legacyId"))
            .bind(forge_core::text::trim(text(e, "title")).to_lowercase()),
        "document" => query
            .bind(text(e, "title"))
            .bind(legacy_uuid(text(&e["content"], "sourceId"))),
        _ => query.bind(text(e, "title")),
    };
    Ok(query.fetch_all(c).await?)
}
pub(super) async fn mapping(
    c: &mut PgConnection,
    a: &Actor,
    m: &Value,
    e: &Value,
    options: ImportOptions,
) -> Result<Option<Value>, StoreError> {
    if e["kind"] != "issue" || !e["draft"].is_object() || e["canonicalProjection"] == true {
        return Ok(None);
    }
    let parent =
        references::resolve(c, a, m, e, "issue", text(&e["draft"], "parentId"), options).await?;
    let project =
        references::resolve(c, a, m, e, "project", text(&e["draft"], "project"), options).await?;
    let mut mapping = json!({"parentId":if parent.is_empty(){Value::Null}else{json!(parent)},"projectId":if project.is_empty(){Value::Null}else{json!(project)}});
    if m["modules"]["milestones"] == true && !text(&e["draft"], "milestone").is_empty() {
        mapping["milestoneId"] = json!(
            references::resolve(
                c,
                a,
                m,
                e,
                "milestone",
                &format!(
                    "{}::{}",
                    text(&e["draft"], "project"),
                    text(&e["draft"], "milestone")
                ),
                options
            )
            .await?
        );
    }
    Ok(Some(mapping))
}
pub(super) fn mapping_matches(mapping: &Value, live: &Value) -> bool {
    live["relationships"]["parentId"] == mapping["parentId"]
        && live["relationships"]["projectId"] == mapping["projectId"]
        && mapping
            .get("milestoneId")
            .is_none_or(|v| *v == live["relationships"]["milestoneId"])
}
pub(super) async fn reconcile(
    c: &mut PgConnection,
    a: &Actor,
    m: &Value,
    e: &mut Value,
    options: ImportOptions,
) -> Result<Decision, StoreError> {
    let mapping = mapping(c, a, m, e, options).await?;
    let aliases = aliases(c, a, e).await?;
    if e["reviewRequired"] != true
        && let Some(exact) = aliases
            .iter()
            .find(|r| r["fingerprint"] == e["fingerprint"])
        && let Some(live) = target(c, a, e, text(exact, "canonicalId"), true, options).await?
        && live["fingerprint"] == exact["targetFingerprint"]
        && references::relationships(c, a, m, e, text(exact, "canonicalId"), options).await?
        && mapping
            .as_ref()
            .is_none_or(|mapping| mapping_matches(mapping, &live))
    {
        let mut complete = true;
        if !array(e, "files").is_empty() {
            let issue = targets::raw(c, a, "issue", id(&live, "id")?, false)
                .await?
                .ok_or(StoreError::Forbidden)?;
            complete = array(e, "files").iter().all(|s| {
                array(&issue["properties"], "attachments").iter().any(|f| {
                    forge_core::comments::truthy(&f["fileId"])
                        && !forge_core::comments::truthy(&f["data"])
                        && ["name", "checksum", "sizeBytes"]
                            .iter()
                            .all(|k| f[*k] == s[*k])
                })
            });
        }
        if complete {
            return Ok(Decision::Reuse {
                id: text(&live, "id").into(),
                reviewed: false,
            });
        }
        e["state"] = json!("review");
        e["message"] = json!(
            "An overlapping import has unfinished files. Resume that import, or review keeping a separate copy."
        );
    }
    let projection = e["canonicalProjection"] == true;
    let possible = if projection {
        vec![]
    } else {
        candidates(c, a, e).await?
    };
    let mut ids = vec![];
    let mut seen = HashSet::new();
    if !projection {
        for alias in &aliases {
            let uid = id(alias, "canonicalId")?;
            if seen.insert(uid) {
                ids.push(uid);
            }
        }
    }
    for uid in &possible {
        if seen.insert(*uid) {
            ids.push(*uid);
        }
    }
    if projection
        && let Ok(uid) = id(e, "canonicalId")
        && seen.insert(uid)
    {
        ids.push(uid);
    }
    let mut live = vec![];
    for uid in ids {
        if let Some(r) = target(c, a, e, &uid.to_string(), true, options).await? {
            live.push(r);
        }
    }
    let content = e.get("content").is_some_and(Value::is_object);
    if aliases.is_empty() && possible.is_empty() && !projection && !content {
        remove(e, "conflict");
        return Ok(Decision::New { both: false });
    }
    let confirmation = if content {
        let mut v = references::confirmation(c, a, m, e, options).await?;
        v["newRecord"] = json!(aliases.is_empty() && possible.is_empty() && !projection);
        Some(v)
    } else {
        None
    };
    let mut dependencies = vec![];
    for (kind, legacy) in checkpoint::content_dependencies(e) {
        let canonical = references::resolve(c, a, m, e, &kind, &legacy, options).await?;
        dependencies.push(json!([kind, legacy, canonical]));
    }
    let mut body = json!({"source":e["fingerprint"],"contentMapping":dependencies,"aliases":aliases,"candidates":live});
    if let Some(v) = &confirmation {
        body["contentConfirmation"] = v.clone();
    }
    if let Some(v) = mapping {
        body["mapping"] = v;
    }
    let fingerprint = hash(&body);
    let mut candidates = vec![];
    for r in &live {
        candidates.push(json!({"id":r["id"],"title":r["title"],"revision":r["revision"],"details":r["details"],"canMigrateFiles":conversion_available(c,a,e,text(r,"id")).await?}));
    }
    e["conflict"] = json!({"fingerprint":fingerprint,"candidates":candidates});
    if let Some(v) = &confirmation {
        e["conflict"]["contentConfirmation"] = v.clone();
    }
    if e["decision"]["fingerprint"] != fingerprint {
        e["state"] = json!("review");
        e["message"] = json!(if confirmation.is_some()
            && aliases.is_empty()
            && possible.is_empty()
            && !projection
        {
            "Confirm that you are entitled to import this content into the displayed destination. No content has been published."
        } else {
            "A matching or changed shared record needs your review. No shared content was changed."
        });
        return Ok(Decision::Blocked);
    }
    let choice = text(&e["decision"], "choice").to_owned();
    if content
        && ["confirm-content", "keep-both"].contains(&choice.as_str())
        && e["decision"]["ownershipConfirmed"] != true
    {
        e["state"] = json!("review");
        return Ok(Decision::Blocked);
    }
    if choice == "confirm-content" {
        if !content || !aliases.is_empty() || !possible.is_empty() || projection {
            e["state"] = json!("review");
            e["message"] = json!(
                "This source now matches a shared record. Review the current comparison before importing."
            );
            return Ok(Decision::Blocked);
        }
        return Ok(Decision::New { both: false });
    }
    if projection && !["keep-server", "skip"].contains(&choice.as_str()) {
        e["state"] = json!("review");
        e["message"] = json!(
            "Keep or skip the existing canonical record. A saved projection cannot authorize a new copy."
        );
        return Ok(Decision::Blocked);
    }
    match choice.as_str() {
        "migrate-files" => {
            if live.len() == 1 && conversion_available(c, a, e, text(&live[0], "id")).await? {
                return Ok(Decision::Convert(text(&live[0], "id").into()));
            }
            e["state"] = json!("review");
            e["message"] =
                json!("The existing legacy files changed. Review the current record again.");
            Ok(Decision::Blocked)
        }
        "skip" => Ok(Decision::Skip),
        "keep-server" => {
            if live.len() == 1 {
                return Ok(Decision::Reuse {
                    id: text(&live[0], "id").into(),
                    reviewed: true,
                });
            }
            e["state"] = json!("review");
            e["message"] =
                json!("Skip this record or keep both; there is no single available target.");
            Ok(Decision::Blocked)
        }
        "keep-both" => Ok(Decision::New { both: true }),
        _ => Err(StoreError::InvalidInput),
    }
}
