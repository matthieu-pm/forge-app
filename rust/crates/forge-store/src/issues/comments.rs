use super::*;
use forge_core::comments::{self as content, CommentCommand};
use std::collections::HashMap;
fn reject(message: &'static str) -> StoreError {
    StoreError::IssueRejected(message)
}
async fn require_issue(
    connection: &mut PgConnection,
    actor: &Actor,
    issue: Uuid,
    team: Option<Uuid>,
) -> Result<(), StoreError> {
    policy::scope(actor, ApiScope::IssuesRead)?;
    let row = policy::issue(connection, actor, issue, false).await?;
    if team.is_some_and(|id| id != row.team_id) {
        return Err(StoreError::Forbidden);
    }
    Ok(())
}
async fn eligible(
    connection: &mut PgConnection,
    actor: &Actor,
    issue: Uuid,
    ids: Option<&[String]>,
    query: &str,
) -> Result<Vec<Value>, StoreError> {
    let query = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    Ok(sqlx::query_scalar("SELECT jsonb_build_object('id',u.id,'name',left(u.name,200),'username',u.username) FROM member m JOIN \"user\" u ON u.id=m.user_id WHERE m.organization_id=$1 AND EXISTS(SELECT 1 FROM issues i JOIN teams t ON t.id=i.team_id AND t.workspace_id=i.workspace_id WHERE i.id=$2 AND i.workspace_id=$1 AND i.deleted_at IS NULL AND i.archived_at IS NULL AND i.purged_at IS NULL AND t.deleted_at IS NULL AND (t.visibility='workspace' OR string_to_array(replace(m.role,' ',''),',') && ARRAY['owner','admin']::text[] OR EXISTS(SELECT 1 FROM team_members tm WHERE tm.workspace_id=$1 AND tm.team_id=t.id AND tm.user_id=u.id))) AND CASE WHEN $3::text[] IS NOT NULL THEN u.id=ANY($3) ELSE (u.name ILIKE $4 OR u.username ILIKE $4) END ORDER BY u.name,u.id LIMIT $5")
        .bind(&actor.workspace_id).bind(issue).bind(ids).bind(format!("%{query}%")).bind(if ids.is_some(){100_i64}else{30_i64}).fetch_all(connection).await?)
}
pub async fn mentions(
    database: &Database,
    actor: &Actor,
    issue: Uuid,
    query: &str,
) -> Result<Value, StoreError> {
    if forge_core::text::length(query) > 100 {
        return Err(StoreError::InvalidInput);
    }
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let actor = current_actor(&mut tx, actor).await?;
    require_issue(&mut tx, &actor, issue, None).await?;
    let targets = eligible(&mut tx, &actor, issue, None, query).await?;
    tx.commit().await?;
    Ok(json!({"targets":targets,"canModerate":policy::privileged(&actor)}))
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Commented {
    issue_id: Uuid,
    comment_id: Uuid,
}
struct Comment<'a> {
    input: &'a Value,
    issue: Uuid,
    team: Uuid,
}
#[async_trait]
impl CommandHandler for Comment<'_> {
    type Output = Commented;
    async fn authorize(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
        _value: Option<&Commented>,
    ) -> Result<(), StoreError> {
        mutation_fence(connection, actor).await?;
        fields::require_team(connection, actor, self.team).await?;
        require_issue(connection, actor, self.issue, Some(self.team)).await
    }
    async fn run(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
    ) -> Result<CommandResult<Commented>, StoreError> {
        sqlx::query("SELECT public.forge_lock_issue_graph($1)")
            .bind(&actor.workspace_id)
            .execute(&mut *connection)
            .await?;
        sqlx::query("SELECT id FROM member WHERE organization_id=$1 FOR SHARE")
            .bind(&actor.workspace_id)
            .fetch_all(&mut *connection)
            .await?;
        sqlx::query("SELECT id FROM team_members WHERE team_id=$1 FOR SHARE")
            .bind(self.team)
            .fetch_all(&mut *connection)
            .await?;
        let mut properties: Value = sqlx::query_scalar(
            "SELECT properties FROM issues WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
        )
        .bind(self.issue)
        .bind(&actor.workspace_id)
        .fetch_optional(&mut *connection)
        .await?
        .ok_or(StoreError::Forbidden)?;
        require_issue(connection, actor, self.issue, Some(self.team)).await?;
        let mut comments = properties
            .get("comments")
            .filter(|v| !v.is_null())
            .map(|v| v.as_array().cloned().ok_or(StoreError::InvalidInput))
            .transpose()?
            .unwrap_or_default();
        let comment_id = id(self.input, "commentId")?;
        let action = text(self.input, "action");
        let position = comments
            .iter()
            .position(|c| text(c, "id") == comment_id.to_string());
        let before = position.map(|p| comments[p].clone());
        if (action == "create") == before.is_some()
            || before
                .as_ref()
                .is_some_and(|c| text(c, "author") != actor.user_id && !policy::privileged(actor))
        {
            return Err(reject(
                "This comment is unavailable or you cannot change it.",
            ));
        }
        if let Some(before) = &before
            && (before.get("version").unwrap_or(&json!(0)) != &self.input["expectedVersion"]
                || (before["deleted"] == true && action == "edit")
                || (action == "delete" && before["deleted"] == true)
                || (action == "restore" && before["deleted"] != true))
        {
            return Err(StoreError::CommentConflict);
        }
        if !text(self.input, "parentId").is_empty()
            && !comments.iter().any(|c| {
                c["id"] == self.input["parentId"]
                    && text(c, "parentId").is_empty()
                    && c["deleted"] != true
            })
        {
            return Err(reject("This thread is no longer available for replies."));
        }
        let name: Option<String> = sqlx::query_scalar("SELECT name FROM \"user\" WHERE id=$1")
            .bind(&actor.user_id)
            .fetch_optional(&mut *connection)
            .await?;
        let name = edit::bounded(name.as_deref().unwrap_or("Member"), 200);
        let now = iso(Utc::now());
        let mut document = self.input.get("document").cloned();
        let ids = document
            .as_ref()
            .map(content::mention_ids)
            .unwrap_or_default();
        if ids.len() > 50 {
            return Err(reject("Mention up to 50 people per comment."));
        }
        if let Some(doc) = document {
            let people = if ids.is_empty() {
                vec![]
            } else {
                eligible(connection, actor, self.issue, Some(&ids), "").await?
            };
            if people.len() != ids.len() {
                return Err(reject(
                    "One or more mentions are unavailable. Choose people with current issue access.",
                ));
            }
            let people: HashMap<_, _> = people
                .into_iter()
                .map(|p| (text(&p, "id").to_owned(), text(&p, "name").to_owned()))
                .collect();
            document = Some(
                content::document(content::resolve_mentions(doc, &people), false)
                    .map_err(|_| reject("Resolved mentions exceed the comment content limit."))?,
            );
        }
        let mut comment = if action == "create" {
            let document = document.as_ref().ok_or(StoreError::InvalidInput)?;
            json!({"id":comment_id,"parentId":self.input["parentId"],"attachmentId":"","resolved":false,"author":actor.user_id,"authorName":name,"body":content::plain_text(document),"document":document,"version":0,"createdAt":now,"edited":false,"deleted":false,"attachments":[],"reactions":[]})
        } else {
            let mut comment = before.as_ref().unwrap().clone();
            comment["version"] =
                json!(comment.get("version").and_then(Value::as_i64).unwrap_or(0) + 1);
            if action == "edit" {
                let document = document.as_ref().ok_or(StoreError::InvalidInput)?;
                comment["document"] = document.clone();
                comment["body"] = json!(content::plain_text(document));
                comment["edited"] = json!(true);
                comment["editedAt"] = json!(now);
                comment["editedBy"] = json!(actor.user_id);
                comment["editedByName"] = json!(name);
            } else {
                comment["deleted"] = json!(action == "delete");
                comment["deletedAt"] = if action == "delete" {
                    json!(now)
                } else {
                    Value::Null
                };
                comment["deletedBy"] = if action == "delete" {
                    json!(actor.user_id)
                } else {
                    Value::Null
                };
            }
            comment
        };
        let uploads = self.input["uploadIds"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| Uuid::parse_str(v.as_str().unwrap()).map_err(|_| StoreError::InvalidInput))
            .collect::<Result<Vec<_>, _>>()?;
        if !uploads.is_empty() {
            let existing = comment.get("attachments").cloned().unwrap_or(json!([]));
            comment["attachments"] = bind_files(
                connection,
                actor,
                self.issue,
                &uploads,
                existing,
                Some(comment_id),
            )
            .await?;
        }
        if let Some(position) = position {
            comments[position] = comment.clone();
        } else {
            comments.push(comment.clone());
        }
        properties["comments"] = json!(comments);
        sqlx::query("UPDATE issues SET properties=$1 WHERE id=$2")
            .bind(properties)
            .bind(self.issue)
            .execute(&mut *connection)
            .await?;
        let previous_ids = before
            .as_ref()
            .and_then(|c| c.get("document"))
            .and_then(|d| content::document(d.clone(), false).ok())
            .map(|d| content::mention_ids(&d))
            .unwrap_or_default();
        let event = json!({"issueId":self.issue,"teamId":self.team,"commentId":comment_id,"authorId":comment["author"],"actorId":actor.user_id,"version":comment["version"]});
        let mut events = vec![OutboxEvent {
            topic: format!(
                "issue.comment.{}",
                match action {
                    "create" => "created",
                    "edit" => "edited",
                    "delete" => "deleted",
                    _ => "restored",
                }
            ),
            payload: event.as_object().unwrap().clone(),
        }];
        for recipient in ids.into_iter().filter(|id| !previous_ids.contains(id)) {
            let mut payload = event.as_object().unwrap().clone();
            payload.insert("recipientId".into(), json!(recipient));
            events.push(OutboxEvent {
                topic: "issue.comment.mentioned".into(),
                payload,
            });
        }
        Ok(CommandResult {
            value: Commented {
                issue_id: self.issue,
                comment_id,
            },
            resource_type: "issue".into(),
            resource_id: self.issue.to_string(),
            events,
        })
    }
}
pub(super) async fn bind_files(
    connection: &mut PgConnection,
    actor: &Actor,
    issue: Uuid,
    ids: &[Uuid],
    existing: Value,
    comment: Option<Uuid>,
) -> Result<Value, StoreError> {
    let mut attachments = existing
        .as_array()
        .cloned()
        .ok_or(StoreError::InvalidInput)?;
    if attachments.len() + ids.len() > 5 {
        return Err(reject("Attach up to 5 files."));
    }
    if ids.is_empty() {
        return Ok(existing);
    }
    let rows:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('file',to_jsonb(f),'intent',to_jsonb(u)) FROM resource_files f JOIN file_upload_intents u ON f.id=u.id WHERE f.id=ANY($1) AND f.workspace_id=$2 AND f.issue_id=$3 AND f.created_by_user_id=$4 AND (f.attachment_state='unbound' OR f.attachment_state IS NULL) AND f.deleted_at IS NULL AND u.workspace_id=$2 AND u.user_id=$4 AND u.state='ready' ORDER BY f.id FOR UPDATE OF f,u")
        .bind(ids).bind(&actor.workspace_id).bind(issue).bind(&actor.user_id).fetch_all(&mut *connection).await?;
    if rows.len() != ids.len()
        || rows.iter().any(|r| {
            let f = &r["file"];
            let u = &r["intent"];
            u["target"]["kind"] != "issue"
                || u["target"]["id"] != issue.to_string()
                || u["storage_reference"] != f["storage_reference"]
                || u["checksum"] != f["checksum"]
                || u["size_bytes"] != f["size_bytes"]
                || !u["result"].is_object()
                || u["result"]["checksum"] != f["checksum"]
                || u["result"]["sizeBytes"] != f["size_bytes"]
                || u["result"]["contentType"] != f["content_type"]
        })
    {
        return Err(reject(
            "The upload is unavailable, already attached, or not ready. Upload it again.",
        ));
    }
    sqlx::query(
        "UPDATE resource_files SET attachment_state='attached',comment_id=$1 WHERE id=ANY($2)",
    )
    .bind(comment)
    .bind(ids)
    .execute(connection)
    .await?;
    for id in ids {
        let f = &rows
            .iter()
            .find(|r| r["file"]["id"] == id.to_string())
            .unwrap()["file"];
        attachments.push(json!({"id":id,"fileId":id,"name":f["name"],"data":"","contentType":f["content_type"],"sizeBytes":f["size_bytes"],"checksum":f["checksum"]}));
    }
    Ok(json!(attachments))
}
pub async fn comment(
    database: &Database,
    actor: &Actor,
    input: &CommentCommand,
) -> Result<Value, StoreError> {
    let input = input.as_value();
    let issue = id(input, "issueId")?;
    let team = id(input, "teamId")?;
    match commands::execute(
        database,
        actor,
        Command {
            key: text(input, "commandKey"),
            operation: "issues.comment@1",
            input,
            status: 200,
        },
        &Comment { input, issue, team },
    )
    .await
    {
        Ok(result) => Ok(
            json!({"status":"saved","replayed":result.replayed,"records":read_current(database,actor,&[issue]).await?}),
        ),
        Err(StoreError::IssueRejected(message)) => {
            Ok(json!({"status":"rejected","message":message,"records":[]}))
        }
        Err(StoreError::CommentConflict) => {
            Ok(json!({"status":"conflict","records":read_current(database,actor,&[issue]).await?}))
        }
        Err(error) => Err(error),
    }
}
