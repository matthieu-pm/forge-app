use super::*;
#[derive(FromRow)]
struct Row {
    id: Uuid,
    title: String,
    number: i32,
    revision: i32,
    archived_at: Option<DateTime<Utc>>,
    deleted_at: Option<DateTime<Utc>>,
    purge_started_at: Option<DateTime<Utc>>,
    properties: Value,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Changed {
    issue_id: Uuid,
    revision: i32,
    active: bool,
}
struct Lifecycle<'a> {
    input: &'a Value,
    team: Uuid,
    issue: Uuid,
}
impl Lifecycle<'_> {
    async fn row(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
        lock: bool,
    ) -> Result<Row, StoreError> {
        let sql = format!(
            "SELECT i.id,i.title,i.number,i.revision,i.archived_at,i.deleted_at,i.purge_started_at,i.properties FROM issues i WHERE i.id=$4 AND i.team_id=$5 AND {} {}",
            policy::retained_issue("i.id"),
            if lock { "FOR UPDATE OF i" } else { "" }
        );
        sqlx::query_as(&sql)
            .bind(&actor.workspace_id)
            .bind(policy::privileged(actor))
            .bind(&actor.user_id)
            .bind(self.issue)
            .bind(self.team)
            .fetch_optional(connection)
            .await?
            .ok_or(StoreError::Forbidden)
    }
}
#[async_trait]
impl CommandHandler for Lifecycle<'_> {
    type Output = Changed;
    async fn authorize(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
        _value: Option<&Changed>,
    ) -> Result<(), StoreError> {
        mutation_fence(connection, actor).await?;
        fields::require_team(connection, actor, self.team).await?;
        self.row(connection, actor, false).await?;
        Ok(())
    }
    async fn run(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
    ) -> Result<CommandResult<Changed>, StoreError> {
        definition_fence(connection, actor).await?;
        sqlx::query("SELECT public.forge_lock_issue_graph($1)")
            .bind(&actor.workspace_id)
            .execute(&mut *connection)
            .await?;
        let row = self.row(connection, actor, true).await?;
        if self.input["expectedRevision"] != row.revision {
            return Err(StoreError::IssueEditConflict);
        }
        let action = text(self.input, "action");
        let now = Utc::now();
        if row.deleted_at.is_some() && action != "restore" {
            return Err(invalid("Restore this issue before changing it."));
        }
        if row.deleted_at.is_none() && action == "restore" {
            return Err(invalid("This issue is not deleted."));
        }
        if action == "restore"
            && (row.purge_started_at.is_some()
                || row
                    .deleted_at
                    .is_some_and(|at| at + chrono::Duration::hours(720) <= now))
        {
            return Err(invalid("The issue recovery period has ended."));
        }
        let deleted = match action {
            "delete" => Some(now),
            "restore" => None,
            _ => row.deleted_at,
        };
        let archived = match action {
            "archive" => Some(row.archived_at.unwrap_or(now)),
            "unarchive" => None,
            _ => row.archived_at,
        };
        let mut properties = row.properties;
        let mut activity = properties["activity"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let verb = match action {
            "delete" => "deleted",
            "restore" => "restored",
            "archive" => "archived",
            _ => "unarchived",
        };
        activity.push(json!({"id":Uuid::new_v4(),"author":actor.user_id,"text":format!("{verb} the issue"),"createdAt":iso(now)}));
        properties["activity"] = json!(activity);
        let revision:i32=sqlx::query_scalar("UPDATE issues SET deleted_at=$1,archived_at=$2,properties=$3 WHERE id=$4 RETURNING revision").bind(deleted).bind(archived).bind(properties).bind(row.id).fetch_one(connection).await?;
        Ok(CommandResult {
            value: Changed {
                issue_id: row.id,
                revision,
                active: deleted.is_none() && archived.is_none(),
            },
            resource_type: "issue".into(),
            resource_id: row.id.to_string(),
            events: vec![OutboxEvent {
                topic: format!("issue.{action}"),
                payload: json!({"issueId":row.id,"teamId":self.team})
                    .as_object()
                    .unwrap()
                    .clone(),
            }],
        })
    }
}
pub async fn lifecycle(
    database: &Database,
    actor: &Actor,
    input: Value,
) -> Result<Value, StoreError> {
    let input = contract::lifecycle(input).map_err(|_| StoreError::InvalidInput)?;
    let handler = Lifecycle {
        team: id(&input, "teamId")?,
        issue: id(&input, "issueId")?,
        input: &input,
    };
    let result = commands::execute(
        database,
        actor,
        Command {
            key: text(&input, "commandKey"),
            operation: "issues.lifecycle@2",
            input: &input,
            status: 200,
        },
        &handler,
    )
    .await;
    let result = match result {
        Err(StoreError::IssueEditConflict) => return Ok(json!({"status":"conflict"})),
        Err(StoreError::Database(sqlx::Error::Database(e)))
            if e.constraint() == Some("workspace_active_issue_limit") =>
        {
            return Err(invalid(
                "This workspace has reached 250 active issues. Archive an issue or upgrade, then retry.",
            ));
        }
        Err(StoreError::Database(sqlx::Error::Database(e)))
            if e.constraint() == Some("issue_recovery_expired") =>
        {
            return Err(invalid("The issue recovery period has ended."));
        }
        result => result?,
    };
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let actor = current_actor(&mut tx, actor).await?;
    fields::require_team(&mut tx, &actor, handler.team).await?;
    let row = handler.row(&mut tx, &actor, false).await?;
    tx.commit().await?;
    Ok(
        json!({"status":"saved","replayed":result.replayed,"value":Changed{issue_id:row.id,revision:row.revision,active:row.deleted_at.is_none()&&row.archived_at.is_none()}}),
    )
}
pub async fn inactive(
    database: &Database,
    actor: &Actor,
    input: Value,
) -> Result<Value, StoreError> {
    let input = contract::inactive_query(input).map_err(|_| StoreError::InvalidInput)?;
    let team = id(&input, "teamId")?;
    let after = input
        .get("after")
        .map(|_| id(&input, "after"))
        .transpose()?;
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let actor = current_actor(&mut tx, actor).await?;
    fields::require_team(&mut tx, &actor, team).await?;
    let sql = format!(
        "SELECT i.id,i.title,i.number,i.revision,i.archived_at,i.deleted_at,i.purge_started_at,'{{}}'::jsonb AS properties FROM issues i WHERE i.team_id=$4 AND {} AND {} AND ($5::uuid IS NULL OR i.id>$5) ORDER BY i.id LIMIT 51",
        policy::retained_issue("i.id"),
        if text(&input, "kind") == "deleted" {
            "i.deleted_at IS NOT NULL AND i.purge_started_at IS NULL AND i.deleted_at+interval '720 hours'>clock_timestamp()"
        } else {
            "i.deleted_at IS NULL AND i.archived_at IS NOT NULL"
        }
    );
    let rows: Vec<Row> = sqlx::query_as(&sql)
        .bind(&actor.workspace_id)
        .bind(policy::privileged(&actor))
        .bind(&actor.user_id)
        .bind(team)
        .bind(after)
        .fetch_all(&mut *tx)
        .await?;
    let items:Vec<_>=rows.iter().take(50).map(|r|json!({"id":r.id,"title":r.title,"number":r.number,"revision":r.revision,"archivedAt":r.archived_at.map(iso),"deletedAt":r.deleted_at.map(iso),"recoverUntil":r.deleted_at.map(|at|iso(at+chrono::Duration::hours(720)))})).collect();
    let next = if rows.len() > 50 {
        Some(rows[49].id)
    } else {
        None
    };
    tx.commit().await?;
    Ok(json!({"items":items,"nextCursor":next}))
}
