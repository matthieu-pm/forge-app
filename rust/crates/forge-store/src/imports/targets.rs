use super::*;

// Hash precisely the source ORM's projected columns, including JavaScript date
// formatting. PostgreSQL JSON timestamps and snake_case column names differ.
pub(super) fn row_value(raw: Value, kind: &str) -> Result<Value, StoreError> {
    let keys: &[&str] = match kind {
        "issue" => &[
            "id",
            "workspace_id",
            "team_id",
            "revision",
            "number",
            "title",
            "assignee_id",
            "creator_id",
            "created_at",
            "updated_at",
            "archived_at",
            "deleted_at",
            "purge_started_at",
            "purged_at",
            "purge_lease_until",
            "purge_token",
            "purge_attempts",
            "purge_error",
            "purge_copy_cursor",
            "properties",
            "cycle_id",
            "legacy_id",
            "status_id",
            "project_id",
            "parent_id",
        ],
        "project" => &[
            "id",
            "workspace_id",
            "name",
            "legacy_id",
            "revision",
            "properties",
        ],
        "initiative" => &[
            "id",
            "workspace_id",
            "name",
            "number",
            "revision",
            "properties",
        ],
        "document" => &[
            "id",
            "workspace_id",
            "title",
            "shared_with_workspace",
            "body",
            "content",
            "icon",
            "section_id",
            "owner_id",
            "updated_by_id",
            "created_at",
            "updated_at",
            "revision",
            "deleted_at",
            "team_id",
            "issue_id",
            "project_id",
        ],
        "view" => &[
            "id",
            "workspace_id",
            "owner_id",
            "visibility",
            "team_id",
            "revision",
            "definition",
            "created_at",
            "updated_at",
            "deleted_at",
        ],
        "alias" => &[
            "id",
            "workspace_id",
            "team_id",
            "kind",
            "legacy_id",
            "fingerprint",
            "canonical_id",
            "target_fingerprint",
        ],
        _ => return Err(StoreError::InvalidInput),
    };
    let mut row = json!({});
    for key in keys {
        let mut parts = key.split('_');
        let mut camel = parts.next().unwrap().to_owned();
        for part in parts {
            let mut chars = part.chars();
            if let Some(c) = chars.next() {
                camel.push(c.to_ascii_uppercase());
                camel.extend(chars);
            }
        }
        let v = raw.get(*key).ok_or(StoreError::InvalidInput)?;
        row[camel] = if (key.ends_with("_at") || *key == "purge_lease_until") && !v.is_null() {
            let date =
                chrono::DateTime::parse_from_rfc3339(v.as_str().ok_or(StoreError::InvalidInput)?)
                    .map_err(|_| StoreError::InvalidInput)?;
            json!(
                date.with_timezone(&Utc)
                    .to_rfc3339_opts(SecondsFormat::Millis, true)
            )
        } else {
            v.clone()
        };
    }
    Ok(row)
}
pub(super) async fn raw(
    c: &mut PgConnection,
    a: &Actor,
    kind: &str,
    uid: Uuid,
    lock: bool,
) -> Result<Option<Value>, StoreError> {
    let (table, condition) = match kind {
        "issue" => ("issues", policy::readable_issue(a, "r.id")),
        "project" => ("projects", policy::readable_project(a, "r.id")),
        "initiative" => (
            "initiatives",
            "($2::boolean OR NOT $2::boolean) AND $3::text IS NOT NULL".into(),
        ),
        "document" => ("documents", policy::readable_document(a, "r.id")),
        "view" => (
            "saved_views",
            format!(
                "r.deleted_at IS NULL AND (r.owner_id=$3 OR r.visibility='workspace' OR (r.visibility='team' AND {})) AND (r.team_id IS NULL OR {})",
                policy::readable_team(a, "r.team_id"),
                policy::readable_team(a, "r.team_id")
            ),
        ),
        _ => return Err(StoreError::InvalidInput),
    };
    let q = format!(
        "SELECT to_jsonb(r) FROM {table} r WHERE r.workspace_id=$1 AND {condition} AND r.id=$4 {}",
        if lock { "FOR SHARE OF r" } else { "" }
    );
    let r: Option<Value> = sqlx::query_scalar(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .bind(uid)
        .fetch_optional(c)
        .await?;
    r.map(|r| row_value(r, kind)).transpose()
}
pub(super) async fn target(
    c: &mut PgConnection,
    a: &Actor,
    e: &Value,
    identifier: &str,
    lock: bool,
    options: ImportOptions,
) -> Result<Option<Value>, StoreError> {
    let Some(uid) = legacy_uuid(identifier) else {
        return Ok(None);
    };
    let kind = text(e, "kind");
    if !["issue", "project"].contains(&kind) {
        require_module(e, modules(c, a, options).await?)?;
    }
    if kind == "milestone" {
        let q = format!(
            "SELECT id,revision,properties FROM projects p WHERE p.workspace_id=$1 AND {} AND p.properties->'milestones' @> $4::jsonb ORDER BY p.id LIMIT 1 FOR SHARE OF p",
            policy::readable_project(a, "p.id")
        );
        let row: Option<(Uuid, i32, Value)> = sqlx::query_as(&q)
            .bind(&a.workspace_id)
            .bind(policy::privileged(a))
            .bind(&a.user_id)
            .bind(json!([{"id":identifier}]))
            .fetch_optional(c)
            .await?;
        return Ok(row.and_then(|(project,rev,props)|array(&props,"milestones").iter().find(|m|m["id"]==identifier).map(|m|json!({"id":identifier,"title":m["name"],"revision":rev,"fingerprint":hash(&json!({"projectId":project,"m":m})),"details":{}}))));
    }
    if kind == "resource" {
        let team = id(e, "teamId")?;
        policy::team(c, a, team).await?;
        let row:Option<(i32,Value)>=sqlx::query_as("SELECT revision,fields FROM team_resource_boards WHERE workspace_id=$1 AND team_id=$2 FOR SHARE").bind(&a.workspace_id).bind(team).fetch_optional(c).await?;
        return Ok(row.and_then(|(rev,fields)|array(&fields,"sections").iter().chain(array(&fields,"links")).find(|item|item["id"]==identifier).map(|item|json!({"id":identifier,"title":item.get("name").unwrap_or(&item["title"]),"revision":rev,"fingerprint":hash(&json!({"teamId":e["teamId"],"item":item})),"details":{}}))));
    }
    let Some(mut row) = raw(
        c,
        a,
        kind,
        uid,
        lock || !["issue", "project"].contains(&kind),
    )
    .await?
    else {
        return Ok(None);
    };
    if kind == "initiative" {
        let ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT project_id FROM initiative_projects WHERE initiative_id=$1 ORDER BY project_id",
        )
        .bind(uid)
        .fetch_all(&mut *c)
        .await?;
        row["links"] = json!(ids.iter().map(|id| json!({"id":id})).collect::<Vec<_>>());
    }
    let title = match kind {
        "initiative" | "project" => row["name"].clone(),
        "view" => row["definition"]["name"].clone(),
        _ => row["title"].clone(),
    };
    let mut result = json!({"id":row["id"],"title":title,"revision":row["revision"],"fingerprint":hash(&row),"details":{}});
    if kind == "project" {
        result["details"] = json!({"summary":text(&row["properties"],"summary"),"status":text(&row["properties"],"status"),"lead":text(&row["properties"],"leadId")});
    }
    if kind == "issue" {
        let mut parent = String::new();
        let mut project = String::new();
        if let Ok(id) = id(&row, "parentId")
            && raw(c, a, "issue", id, false).await?.is_some()
        {
            parent = text(&row, "parentId").into();
        }
        if let Ok(id) = id(&row, "projectId")
            && raw(c, a, "project", id, false).await?.is_some()
        {
            project = text(&row, "projectId").into();
        }
        result["details"] = json!({"status":row["statusId"],"assignee":row["assigneeId"].as_str().unwrap_or("Unassigned"),"labels":row["properties"].get("labels").unwrap_or(&json!("")),"project":project,"cycle":text(&row,"cycleId"),"parent":parent});
        if let Some(d) = row["properties"].get("description") {
            result["details"]["description"] = d.clone();
        }
        result["relationships"] = json!({"parentId":row["parentId"],"projectId":row["projectId"],"milestoneId":if text(&row["properties"],"milestone").is_empty(){Value::Null}else{row["properties"]["milestone"].clone()}});
    }
    Ok(Some(result))
}
pub(super) async fn conversion_available(
    c: &mut PgConnection,
    a: &Actor,
    e: &Value,
    identifier: &str,
) -> Result<bool, StoreError> {
    if e["kind"] != "issue" || array(e, "files").is_empty() {
        return Ok(false);
    }
    let Some(uid) = legacy_uuid(identifier) else {
        return Ok(false);
    };
    let Some(row) = raw(c, a, "issue", uid, false).await? else {
        return Ok(false);
    };
    if row["legacyId"] != e["legacyId"] {
        return Ok(false);
    }
    let inline: Vec<_> = array(&row["properties"], "attachments")
        .iter()
        .filter(|f| !forge_core::comments::truthy(&f["fileId"]))
        .cloned()
        .collect();
    let Ok(legacy) = contract::validated_files(&inline) else {
        return Ok(false);
    };
    fn keys(files: &[Value]) -> Vec<String> {
        let mut k: Vec<_> = files
            .iter()
            .map(|f| javascript_stringify(&json!([f["name"], f["checksum"], f["sizeBytes"]])))
            .collect();
        k.sort();
        k
    }
    Ok(keys(&legacy) == keys(array(e, "files")))
}
