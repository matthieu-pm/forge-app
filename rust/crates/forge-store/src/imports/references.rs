use super::*;
use std::collections::BTreeSet;
pub(super) async fn resolve(
    c: &mut PgConnection,
    a: &Actor,
    m: &Value,
    e: &Value,
    kind: &str,
    legacy: &str,
    options: ImportOptions,
) -> Result<String, StoreError> {
    if legacy.is_empty() {
        return Ok(String::new());
    }
    let selected = checkpoint::references(m, e, kind, legacy);
    let ids: BTreeSet<_> = selected
        .iter()
        .filter_map(|e| e["canonicalId"].as_str().filter(|s| !s.is_empty()))
        .collect();
    if !selected.is_empty()
        && (ids.len() != 1 || selected.iter().any(|e| text(e, "canonicalId").is_empty()))
    {
        return Err(StoreError::Planning(
            "A referenced source record must be resolved first.",
        ));
    }
    for selected in &selected {
        let Some(origin) = selected.get("manifestId") else {
            continue;
        };
        let origin = origin
            .as_str()
            .ok_or(StoreError::InvalidInput)?
            .parse::<Uuid>()
            .map_err(|_| StoreError::InvalidInput)?;
        let raw:Option<String>=sqlx::query_scalar("SELECT encoded_manifest FROM legacy_imports WHERE id=$1 AND workspace_id=$2 AND user_id=$3 FOR SHARE").bind(origin).bind(&a.workspace_id).bind(&a.user_id).fetch_optional(&mut *c).await?;
        let settled = raw
            .as_deref()
            .map(forge_core::json::parse)
            .transpose()
            .map_err(|_| StoreError::InvalidInput)?
            .unwrap_or(Value::Null);
        let original = array(&settled, "entries")
            .iter()
            .find(|r| r["id"] == selected["id"]);
        let valid = forge_core::comments::truthy(&settled["completedAt"])
            && settled["actorId"] == a.user_id
            && settled["workspaceId"] == a.workspace_id
            && original.is_some_and(|r| {
                r["state"] == "saved"
                    && [
                        "canonicalId",
                        "kind",
                        "teamId",
                        "legacyId",
                        "sourceKey",
                        "sourceChecksum",
                    ]
                    .iter()
                    .all(|k| r[*k] == selected[*k])
            });
        if !valid {
            return Err(StoreError::Planning(
                "A settled reference changed or is unavailable. Refresh import progress before retrying.",
            ));
        }
        let original = original.unwrap();
        if target(
            c,
            a,
            original,
            text(original, "canonicalId"),
            false,
            options,
        )
        .await?
        .is_none()
        {
            return Err(StoreError::Planning(
                "A settled reference changed or is unavailable. Refresh import progress before retrying.",
            ));
        }
        let index = array(&settled, "sources").iter().position(|s| {
            s["key"] == original["sourceKey"] && s["checksum"] == original["sourceChecksum"]
        });
        if let Some(index) = index
            && backup(c, a, &settled, index, true).await?.is_some()
        {
            continue;
        }
        return Err(StoreError::Planning(
            "A settled reference backup is unavailable. Its mapping cannot be reconciled.",
        ));
    }
    if let Some(id) = ids.first() {
        return Ok((*id).into());
    }
    if kind == "milestone"
        && let Some((project, value)) = legacy.split_once("::")
    {
        let project = Box::pin(resolve(c, a, m, e, "project", project, options)).await?;
        let project = targets::raw(
            c,
            a,
            "project",
            project.parse().map_err(|_| StoreError::InvalidInput)?,
            true,
        )
        .await?;
        let matches: Vec<_> = project
            .as_ref()
            .map(|p| array(&p["properties"], "milestones"))
            .unwrap_or_default()
            .iter()
            .filter(|s| {
                s["id"] == value
                    || s["name"] == value
                    || array(s, "aliases").iter().any(|s| s == value)
            })
            .collect();
        if matches.len() != 1 {
            return Err(StoreError::Planning(
                "A project milestone is missing, ambiguous or unavailable.",
            ));
        }
        return Ok(text(matches[0], "id").into());
    }
    if !["issue", "project"].contains(&kind) {
        let mut reference = e.clone();
        reference["kind"] = json!(kind);
        return target(c, a, &reference, legacy, false, options)
            .await?
            .map(|r| text(&r, "id").into())
            .ok_or(StoreError::Planning(
                "A content relationship is missing or unavailable.",
            ));
    }
    let (table, condition) = if kind == "issue" {
        (
            "issues",
            format!(
                "{} AND ($6::uuid IS NULL OR r.team_id=$6)",
                policy::readable_issue("r.id")
            ),
        )
    } else {
        ("projects", policy::readable_project("r.id"))
    };
    let q = format!(
        "SELECT r.id FROM {table} r WHERE r.workspace_id=$1 AND {condition} AND (r.legacy_id=$4 OR r.id=$5)"
    );
    let query = sqlx::query_scalar::<_, Uuid>(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .bind(legacy)
        .bind(legacy_uuid(legacy));
    let query = if kind == "issue" {
        query.bind(if e["kind"] == "view" {
            None
        } else {
            Some(id(e, "teamId")?)
        })
    } else {
        query
    };
    let ids = query.fetch_all(c).await?;
    if ids.len() != 1 {
        return Err(StoreError::Planning(
            "A reference is missing, ambiguous or unavailable. Its source remains preserved.",
        ));
    }
    Ok(ids[0].to_string())
}
pub(super) async fn mapped_view(
    c: &mut PgConnection,
    a: &Actor,
    m: &Value,
    e: &Value,
    options: ImportOptions,
) -> Result<Value, StoreError> {
    let mut d = e["content"]["definition"].clone();
    let kind = text(&d, "kind").to_owned();
    let rules = if kind == "issues" {
        &mut d["filters"]["rules"]
    } else {
        &mut d["filters"]
    };
    for rule in rules.as_array_mut().ok_or(StoreError::InvalidInput)? {
        if text(rule, "value").is_empty() || ["set", "notSet"].contains(&text(rule, "operator")) {
            continue;
        }
        let kind = match text(rule, "field") {
            "project" | "Specific project" => "project",
            "parentId" => "issue",
            _ => continue,
        };
        rule["value"] = json!(resolve(c, a, m, e, kind, text(rule, "value"), options).await?);
    }
    forge_core::saved_views::definition(d).map_err(|_| StoreError::InvalidInput)
}
pub(super) async fn relationships(
    c: &mut PgConnection,
    a: &Actor,
    m: &Value,
    e: &Value,
    canonical: &str,
    options: ImportOptions,
) -> Result<bool, StoreError> {
    let Some(content) = e.get("content") else {
        return Ok(true);
    };
    let uid = canonical
        .parse::<Uuid>()
        .map_err(|_| StoreError::InvalidInput)?;
    match text(content, "kind") {
        "initiative" => {
            let actual:Vec<Uuid>=sqlx::query_scalar("SELECT project_id FROM initiative_projects WHERE workspace_id=$1 AND initiative_id=$2").bind(&a.workspace_id).bind(uid).fetch_all(&mut *c).await?;
            let actual: BTreeSet<_> = actual.into_iter().map(|v| v.to_string()).collect();
            let mut expected = BTreeSet::new();
            for p in array(content, "projectIds") {
                expected.insert(
                    resolve(
                        c,
                        a,
                        m,
                        e,
                        "project",
                        p.as_str().ok_or(StoreError::InvalidInput)?,
                        options,
                    )
                    .await?,
                );
            }
            Ok(actual == expected)
        }
        "document" => {
            let Some(row) = targets::raw(c, a, "document", uid, false).await? else {
                return Ok(false);
            };
            let project = if text(content, "projectId").is_empty() {
                Value::Null
            } else {
                json!(resolve(c, a, m, e, "project", text(content, "projectId"), options).await?)
            };
            let section = if text(content, "sectionId").is_empty() {
                Value::Null
            } else {
                json!(
                    resolve(
                        c,
                        a,
                        m,
                        e,
                        "resource",
                        &format!("section:{}", text(content, "sectionId")),
                        options
                    )
                    .await?
                )
            };
            Ok(row["projectId"] == project
                && row["teamId"]
                    == if project.is_null() {
                        e["teamId"].clone()
                    } else {
                        Value::Null
                    }
                && row["sectionId"] == section
                && row["sharedWithWorkspace"] == false)
        }
        "milestone" => {
            let project =
                resolve(c, a, m, e, "project", text(content, "projectId"), options).await?;
            let row = targets::raw(
                c,
                a,
                "project",
                project.parse().map_err(|_| StoreError::InvalidInput)?,
                false,
            )
            .await?;
            Ok(row.is_some_and(|r| {
                array(&r["properties"], "milestones")
                    .iter()
                    .any(|s| s["id"] == canonical)
            }))
        }
        "resource" if content["fields"].get("title").is_some() => {
            let fields: Option<Value> = sqlx::query_scalar(
                "SELECT fields FROM team_resource_boards WHERE workspace_id=$1 AND team_id=$2",
            )
            .bind(&a.workspace_id)
            .bind(id(e, "teamId")?)
            .fetch_optional(&mut *c)
            .await?;
            let section = if text(content, "sectionId").is_empty() {
                Value::Null
            } else {
                json!(
                    resolve(
                        c,
                        a,
                        m,
                        e,
                        "resource",
                        &format!("section:{}", text(content, "sectionId")),
                        options
                    )
                    .await?
                )
            };
            Ok(fields.is_some_and(|f| {
                array(&f, "links")
                    .iter()
                    .any(|l| l["id"] == canonical && l["sectionId"] == section)
            }))
        }
        "view" => {
            let expected = mapped_view(c, a, m, e, options).await?;
            Ok(targets::raw(c, a, "view", uid, false)
                .await?
                .is_some_and(|r| {
                    r["ownerId"] == a.user_id && hash(&r["definition"]) == hash(&expected)
                }))
        }
        _ => Ok(true),
    }
}
pub(super) async fn confirmation(
    c: &mut PgConnection,
    a: &Actor,
    m: &Value,
    e: &Value,
    options: ImportOptions,
) -> Result<Value, StoreError> {
    let content = &e["content"];
    let workspace: String = sqlx::query_scalar("SELECT name FROM organization WHERE id=$1")
        .bind(&a.workspace_id)
        .fetch_one(&mut *c)
        .await?;
    let mut scope = "All workspace members".to_owned();
    if content["kind"] == "view" {
        scope = match text(&content["definition"], "visibility") {
            "personal" => "Only your account".into(),
            "team" => "team".into(),
            _ => scope,
        };
    } else if content["kind"] == "resource"
        || (content["kind"] == "document" && text(content, "projectId").is_empty())
    {
        scope = "team".into();
    }
    if scope == "team" {
        let team = id(e, "teamId")?;
        policy::team(c, a, team).await?;
        let name: String =
            sqlx::query_scalar("SELECT name FROM teams WHERE workspace_id=$1 AND id=$2")
                .bind(&a.workspace_id)
                .bind(team)
                .fetch_one(&mut *c)
                .await?;
        scope = format!("Team: {name}");
    }
    if content["kind"] == "milestone"
        || (content["kind"] == "document" && !text(content, "projectId").is_empty())
    {
        let project = resolve(c, a, m, e, "project", text(content, "projectId"), options).await?;
        let row = targets::raw(
            c,
            a,
            "project",
            project.parse().map_err(|_| StoreError::InvalidInput)?,
            false,
        )
        .await?
        .ok_or(StoreError::Forbidden)?;
        scope = format!("Project: {} (project access)", text(&row, "name"));
    }
    let mut v = json!({"destination":format!("{workspace} · {scope}"),"actorId":a.user_id,"workspaceId":a.workspace_id,"teamId":e["teamId"],"policyVersion":1,"entryId":e["id"]});
    if let Some(checksum) = e.get("sourceChecksum") {
        v["sourceChecksum"] = checksum.clone();
    }
    Ok(v)
}
