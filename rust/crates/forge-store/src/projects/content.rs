use super::*;
pub(super) fn reconcile(
    a: &Actor,
    before: &[Value],
    next: &[Value],
    now: &str,
) -> Result<Vec<Value>, StoreError> {
    contract::reconcile(a, before, next, now).map_err(|e| {
        if e.0 == "forbidden" {
            StoreError::Forbidden
        } else {
            invalid(e.0)
        }
    })
}
pub(super) fn milestones(before: &Value, core: &mut Value, now: &str) -> Result<(), StoreError> {
    for milestone in core
        .get_mut("milestones")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        let prior = array(before, "milestones")
            .iter()
            .find(|p| p["id"] == milestone["id"]);
        let mut aliases = prior
            .map(|p| array(p, "aliases").to_vec())
            .unwrap_or_default();
        if let Some(prior) = prior
            && prior["name"] != milestone["name"]
        {
            aliases.push(prior["name"].clone());
        }
        let mut seen = HashSet::new();
        aliases.retain(|v| seen.insert(v.clone()));
        milestone["aliases"] = json!(aliases);
        let mut history = prior
            .map(|p| array(p, "descriptionHistory").to_vec())
            .unwrap_or_default();
        if let Some(prior) = prior
            && forge_core::canonical::javascript_stringify(&prior["description"])
                != forge_core::canonical::javascript_stringify(&milestone["description"])
            && !prior["description"].is_null()
        {
            history.push(json!({"description":prior["description"],"createdAt":now}));
            if history.len() > 50 {
                history.drain(..history.len() - 50);
            }
        }
        milestone["descriptionHistory"] = json!(history);
    }
    contract::unique_milestones(array(core, "milestones")).map_err(|e| invalid(e.0))
}
pub(super) fn milestone_events(
    a: &Actor,
    before: &[Value],
    next: &[Value],
    now: &str,
) -> Vec<Value> {
    next.iter().filter_map(|m|{let old=before.iter().find(|p|p["id"]==m["id"]);if old==Some(m){None}else{Some(json!({"id":Uuid::new_v4(),"authorId":a.user_id,"createdAt":now,"text":format!("{} milestone {}",if old.is_some(){"updated"}else{"added"},text(m,"name"))}))}}).collect()
}
fn references(p: &Value) -> Vec<(String, Uuid)> {
    let mut result = vec![];
    for key in ["updates", "comments"] {
        for post in array(p, key) {
            for entry in std::iter::once(post).chain(array(post, "comments")) {
                for file in array(entry, "attachments") {
                    if let Ok(id) = id(file, "fileId") {
                        result.push((text(entry, "id").into(), id));
                    }
                }
            }
        }
    }
    result
}
#[derive(FromRow)]
struct File {
    id: Uuid,
    name: String,
    content_type: String,
    size_bytes: i32,
    created_by_user_id: Option<String>,
    attachment_state: Option<String>,
    project_post_id: Option<Uuid>,
    deleted: bool,
}
fn normalize(post: &mut Value, post_id: &str, file: &File) {
    if text(post, "id") == post_id {
        for attachment in post["attachments"].as_array_mut().into_iter().flatten() {
            if attachment["fileId"] == file.id.to_string() {
                attachment["id"] = json!(file.id);
                attachment["name"] = json!(file.name);
                attachment["mime"] = json!(file.content_type);
                attachment["sizeBytes"] = json!(file.size_bytes);
            }
        }
    }
}
pub(super) async fn bind_files(
    c: &mut PgConnection,
    a: &Actor,
    project: Uuid,
    before: &Value,
    after: &mut Value,
) -> Result<(), StoreError> {
    let old = references(before);
    let next = references(after);
    let mut files = HashSet::new();
    if next.iter().any(|(_, file)| !files.insert(*file)) {
        return Err(invalid("Attach a file to only one project post."));
    }
    let mut refs = old.clone();
    for reference in &next {
        if !refs.contains(reference) {
            refs.push(reference.clone());
        }
    }
    for (post, file) in refs {
        let row:File=sqlx::query_as("SELECT id,name,content_type,size_bytes,created_by_user_id,attachment_state,project_post_id,deleted_at IS NOT NULL AS deleted FROM resource_files WHERE workspace_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE").bind(&a.workspace_id).bind(project).bind(file).fetch_optional(&mut *c).await?.ok_or(StoreError::Forbidden)?;
        let previous = old.contains(&(post.clone(), file));
        let wanted = next.contains(&(post.clone(), file));
        if row.deleted
            || (!previous
                && (row.created_by_user_id.as_deref() != Some(&a.user_id)
                    || (row.attachment_state.as_deref() != Some("unbound")
                        && !(row.attachment_state.as_deref() == Some("attached")
                            && row.project_post_id.map(|v| v.to_string()).as_deref()
                                == Some(&post)))))
        {
            return Err(StoreError::Forbidden);
        }
        for key in ["updates", "comments"] {
            for entry in after
                .get_mut(key)
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                normalize(entry, &post, &row);
                for comment in entry["comments"].as_array_mut().into_iter().flatten() {
                    normalize(comment, &post, &row);
                }
            }
        }
        let post: Uuid = post.parse().map_err(|_| StoreError::InvalidInput)?;
        sqlx::query("UPDATE resource_files SET attachment_state=$1,project_post_id=$2 WHERE id=$3")
            .bind(if wanted { "attached" } else { "detached" })
            .bind(post)
            .bind(file)
            .execute(&mut *c)
            .await?;
    }
    Ok(())
}
