use super::*;
use contract::{
    DeliveryError,
    delivery::{File, Lookup},
};
#[derive(Clone)]
pub struct FileLookup(pub Database);
fn array<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v[k].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn record(v: Value) -> Result<File, StoreError> {
    Ok(File {
        id: text(&v, "id").into(),
        name: text(&v, "name").into(),
        content_type: text(&v, "content_type").into(),
        size_bytes: v["size_bytes"]
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or(StoreError::InvalidInput)? as usize,
        checksum: text(&v, "checksum").into(),
        storage_reference: text(&v, "storage_reference").into(),
    })
}
#[async_trait::async_trait]
impl Lookup for FileLookup {
    async fn lookup(&self, a: &Actor, target: &Value) -> Result<Option<File>, DeliveryError> {
        self.read(a, target).await.map_err(|e| match e {
            StoreError::Forbidden
            | StoreError::Unauthenticated
            | StoreError::InvalidInput
            | StoreError::EmailNotVerified
            | StoreError::NoActiveWorkspace => DeliveryError::NotFound,
            _ => DeliveryError::Unavailable,
        })
    }
}
impl FileLookup {
    pub async fn read(&self, a: &Actor, target: &Value) -> Result<Option<File>, StoreError> {
        contract::delivery_target(target.clone()).map_err(|_| StoreError::InvalidInput)?;
        if !matches!(a.authentication, Authentication::Session { .. }) || a.scopes.is_some() {
            return Err(StoreError::Forbidden);
        }
        let key = id(text(target, "id"))?;
        let mut tx = self.0.begin().await?;
        let a = current_actor(&mut tx, a).await?;
        let value = match text(target, "kind") {
            "resources" => resource(&mut tx, &a, key).await?,
            "attachments" => {
                policy::scope(&a, ApiScope::AgentsRead)?;
                sqlx::query_scalar("SELECT to_jsonb(f) FROM agent_attachments f WHERE workspace_id=$1 AND user_id=$2 AND id=$3 AND deleted_at IS NULL AND expires_at>clock_timestamp()")
                    .bind(&a.workspace_id).bind(&a.user_id).bind(key).fetch_optional(&mut *tx).await?
            }
            _ => {
                policy::scope(&a, ApiScope::AgentsRead)?;
                artifact_metadata(&mut tx, &a, key, true).await?
            }
        };
        tx.commit().await?;
        value.map(record).transpose()
    }
}
async fn resource(c: &mut PgConnection, a: &Actor, key: Uuid) -> Result<Option<Value>, StoreError> {
    let q = format!(
        "SELECT to_jsonb(f),i.properties::text,p.properties::text,EXISTS(SELECT 1 FROM file_upload_intents u WHERE u.id=f.id AND u.workspace_id=$1) FROM resource_files f LEFT JOIN issues i ON i.id=f.issue_id AND i.workspace_id=$1 LEFT JOIN projects p ON p.id=f.project_id AND p.workspace_id=$1 WHERE f.workspace_id=$1 AND f.id=$4 AND f.deleted_at IS NULL AND ((f.issue_id IS NOT NULL AND {}) OR (f.project_id IS NOT NULL AND {}) OR (f.document_id IS NOT NULL AND {}))",
        policy::readable_issue(a, "f.issue_id"),
        policy::readable_project(a, "f.project_id"),
        policy::readable_document(a, "f.document_id")
    );
    let row: Option<(Value, Option<String>, Option<String>, bool)> = sqlx::query_as(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .bind(key)
        .fetch_optional(c)
        .await?;
    let Some((file, issue, project, direct)) = row else {
        return Ok(None);
    };
    let state = text(&file, "attachment_state");
    if !file["project_id"].is_null() {
        if state != "attached" || file["project_post_id"].is_null() {
            return Ok(None);
        }
        let p = project
            .as_deref()
            .map(forge_core::json::parse)
            .transpose()
            .map_err(|_| StoreError::InvalidInput)?
            .unwrap_or(Value::Null);
        let posts = array(&p, "updates").iter().chain(array(&p, "comments"));
        let found = posts
            .flat_map(|p| std::iter::once(p).chain(array(p, "comments")))
            .any(|p| {
                p["id"] == file["project_post_id"]
                    && array(p, "attachments")
                        .iter()
                        .any(|f| f["fileId"] == file["id"])
            });
        if !found {
            return Ok(None);
        }
    } else if !state.is_empty() || (!file["issue_id"].is_null() && direct) {
        if state != "attached" || file["issue_id"].is_null() {
            return Ok(None);
        }
        let p = issue
            .as_deref()
            .map(forge_core::json::parse)
            .transpose()
            .map_err(|_| StoreError::InvalidInput)?
            .unwrap_or(Value::Null);
        let attachments = if file["comment_id"].is_null() {
            array(&p, "attachments")
        } else {
            let Some(comment) = array(&p, "comments").iter().find(|v| {
                v["id"] == file["comment_id"] && !forge_core::comments::truthy(&v["deleted"])
            }) else {
                return Ok(None);
            };
            array(comment, "attachments")
        };
        if !attachments.iter().any(|f| f["fileId"] == file["id"]) {
            return Ok(None);
        }
    }
    Ok(Some(file))
}
fn within_team(column: &str) -> String {
    format!(
        "EXISTS(SELECT 1 FROM teams scope_team WHERE scope_team.id={column} AND scope_team.workspace_id=l.workspace_id AND scope_team.deleted_at IS NULL AND (scope_team.id=l.team_id OR (lr.fields->>'teamAccess'='all-public-teams' AND l.fields->>'teamAccess'='all-public-teams' AND scope_team.visibility='workspace' AND EXISTS(SELECT 1 FROM teams owner_team WHERE owner_team.id=l.team_id AND owner_team.workspace_id=l.workspace_id AND owner_team.visibility='workspace' AND owner_team.deleted_at IS NULL))))"
    )
}
pub(crate) async fn artifact_metadata(
    c: &mut PgConnection,
    a: &Actor,
    key: Uuid,
    only_live: bool,
) -> Result<Option<Value>, StoreError> {
    let source = format!(
        "((lr.event->>'entity' IS DISTINCT FROM 'issue' OR {}) AND (lr.event->>'entity' IS DISTINCT FROM 'project' OR {}) AND (lr.event->>'entity' IS DISTINCT FROM 'team' OR {}) AND (lr.event->>'entity' IS DISTINCT FROM 'cycle' OR EXISTS(SELECT 1 FROM issue_cycles cycle WHERE cycle.workspace_id=$1 AND cycle.id::text=lr.event->>'entityId' AND {})) AND (lr.event->>'entity' IS DISTINCT FROM 'initiative' OR EXISTS(SELECT 1 FROM initiative_projects ip JOIN project_teams pt ON pt.project_id=ip.project_id AND pt.workspace_id=ip.workspace_id WHERE ip.workspace_id=$1 AND ip.initiative_id::text=lr.event->>'entityId' AND {})))",
        policy::readable_issue(a, "(lr.event->>'entityId')::uuid"),
        policy::readable_project(a, "(lr.event->>'entityId')::uuid"),
        policy::readable_team(a, "(lr.event->>'entityId')::uuid"),
        policy::readable_team(a, "cycle.team_id"),
        policy::readable_team(a, "pt.team_id")
    );
    let scope = format!(
        "CASE lr.event->>'entity' WHEN 'issue' THEN EXISTS(SELECT 1 FROM issues si WHERE si.workspace_id=l.workspace_id AND si.id::text=lr.event->>'entityId' AND {}) WHEN 'project' THEN EXISTS(SELECT 1 FROM project_teams sp WHERE sp.workspace_id=l.workspace_id AND sp.project_id::text=lr.event->>'entityId' AND {}) WHEN 'initiative' THEN EXISTS(SELECT 1 FROM initiative_projects ip JOIN project_teams sp ON sp.project_id=ip.project_id AND sp.workspace_id=ip.workspace_id WHERE ip.workspace_id=l.workspace_id AND ip.initiative_id::text=lr.event->>'entityId' AND {}) WHEN 'cycle' THEN EXISTS(SELECT 1 FROM issue_cycles sc WHERE sc.workspace_id=l.workspace_id AND sc.id::text=lr.event->>'entityId' AND {}) WHEN 'team' THEN {} ELSE true END",
        within_team("si.team_id"),
        within_team("sp.team_id"),
        within_team("sp.team_id"),
        within_team("sc.team_id"),
        within_team("(lr.event->>'entityId')::uuid")
    );
    let q = format!(
        "SELECT to_jsonb(f),(SELECT lr.event FROM loop_runs lr WHERE lr.agent_run_id=r.id)::text,(SELECT CASE WHEN lr.event ? 'comment' OR lr.event ? 'update' THEN forge_loop_snapshot(lr.event->>'entity',(lr.event->>'entityId')::uuid,lr.workspace_id) ELSE NULL END FROM loop_runs lr WHERE lr.agent_run_id=r.id)::text FROM agent_artifacts f JOIN agent_runs r ON r.id=f.run_id JOIN agent_threads t ON t.id=r.thread_id WHERE f.id=$4 AND t.workspace_id=$1 AND (NOT $5::boolean OR (f.deleted_at IS NULL AND (f.retention_expires_at IS NULL OR f.retention_expires_at>clock_timestamp()))) AND ((t.created_by_user_id=$3 AND NOT EXISTS(SELECT 1 FROM loop_runs lr WHERE lr.agent_run_id=r.id)) OR EXISTS(SELECT 1 FROM loop_runs lr JOIN team_loops l ON l.id=lr.loop_id AND l.workspace_id=lr.workspace_id WHERE lr.agent_run_id=r.id AND l.workspace_id=$1 AND l.deleted_at IS NULL AND {source} AND ({scope}) AND {}))",
        policy::readable_team(a, "l.team_id")
    );
    let row: Option<(Value, Option<String>, Option<String>)> = sqlx::query_as(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .bind(key)
        .bind(only_live)
        .fetch_optional(c)
        .await?;
    let Some((file, event, source)) = row else {
        return Ok(None);
    };
    let event = event
        .as_deref()
        .map(forge_core::json::parse)
        .transpose()
        .map_err(|_| StoreError::InvalidInput)?;
    let source = source
        .as_deref()
        .map(forge_core::json::parse)
        .transpose()
        .map_err(|_| StoreError::InvalidInput)?;
    if let Some(event) = event
        && (event.get("comment").is_some() || event.get("update").is_some())
        && !activity_matches(&source.unwrap_or(Value::Null), &event)
    {
        return Ok(None);
    }
    Ok(Some(file))
}
fn activity_matches(source: &Value, event: &Value) -> bool {
    let saved = event
        .get("comment")
        .filter(|v| !v.is_null())
        .or_else(|| event.get("update"));
    let Some(saved) = saved else { return true };
    if !saved["id"].is_string() {
        return false;
    }
    let comment = forge_core::comments::truthy(&event["comment"]);
    let p = &source["properties"];
    let candidates: Vec<&Value> = if comment {
        array(p, "comments")
            .iter()
            .chain(
                array(p, "updates")
                    .iter()
                    .flat_map(|v| array(v, "comments")),
            )
            .collect()
    } else {
        array(p, "updates").iter().collect()
    };
    let Some(entry) = candidates.into_iter().find(|v| v["id"] == saved["id"]) else {
        return false;
    };
    if entry["deleted"] == true || forge_core::comments::truthy(&entry["deletedAt"]) {
        return false;
    }
    let raw = entry
        .get("document")
        .filter(|v| !v.is_null())
        .unwrap_or(&entry["body"]);
    let doc = forge_core::comments::document(raw.clone(), false).ok();
    let text = doc
        .as_ref()
        .map(forge_core::comments::plain_text)
        .unwrap_or_else(|| {
            ["body", "content", "text"]
                .iter()
                .find_map(|k| entry[k].as_str())
                .unwrap_or_default()
                .to_owned()
        });
    if saved["text"] != text {
        return false;
    }
    if comment {
        let original: std::collections::BTreeSet<_> = array(saved, "mentionIds")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let current: std::collections::BTreeSet<_> = doc
            .as_ref()
            .map(forge_core::comments::mention_ids)
            .unwrap_or_default()
            .into_iter()
            .collect();
        if original != current {
            return false;
        }
    }
    true
}
