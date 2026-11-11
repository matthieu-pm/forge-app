use super::*;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Related {
    issue_ids: Vec<Uuid>,
}
async fn visible(
    connection: &mut PgConnection,
    actor: &Actor,
    ids: &[Uuid],
    write: bool,
) -> Result<Vec<Value>, StoreError> {
    policy::scope(actor, ApiScope::IssuesRead)?;
    if write {
        policy::scope(actor, ApiScope::IssuesWrite)?;
    }
    let query = format!(
        "SELECT jsonb_build_object('id',i.id,'title',i.title,'revision',i.revision,'teamId',i.team_id,'teamSlug',t.slug,'identifier',t.identifier,'number',i.number) FROM issues i JOIN teams t ON t.id=i.team_id WHERE i.id=ANY($4) AND i.workspace_id=$1 AND {}",
        policy::readable_issue("i.id")
    );
    let rows: Vec<Value> = sqlx::query_scalar(&query)
        .bind(&actor.workspace_id)
        .bind(policy::privileged(actor))
        .bind(&actor.user_id)
        .bind(ids)
        .fetch_all(&mut *connection)
        .await?;
    if rows.len() != ids.iter().collect::<std::collections::HashSet<_>>().len() {
        return Err(StoreError::Forbidden);
    }
    if write {
        let teams = rows
            .iter()
            .map(|r| id(r, "teamId"))
            .collect::<Result<std::collections::BTreeSet<_>, _>>()?;
        for team in teams {
            fields::require_team(connection, actor, team).await?;
        }
    }
    Ok(rows)
}
struct Relationship<'a> {
    input: &'a Value,
    ids: Vec<Uuid>,
}
#[async_trait]
impl CommandHandler for Relationship<'_> {
    type Output = Related;
    async fn authorize(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
        value: Option<&Related>,
    ) -> Result<(), StoreError> {
        mutation_fence(connection, actor).await?;
        visible(
            connection,
            actor,
            value.map_or(&self.ids, |v| &v.issue_ids),
            true,
        )
        .await?;
        Ok(())
    }
    async fn run(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
    ) -> Result<CommandResult<Related>, StoreError> {
        definition_fence(connection, actor).await?;
        sqlx::query("SELECT public.forge_lock_issue_graph($1)")
            .bind(&actor.workspace_id)
            .execute(&mut *connection)
            .await?;
        visible(connection, actor, &self.ids, true).await?;
        let mut rows:Vec<IssueRow>=sqlx::query_as("SELECT i.*,NULL::jsonb AS sla FROM issues i WHERE workspace_id=$1 AND id=ANY($2) ORDER BY id FOR UPDATE").bind(&actor.workspace_id).bind(&self.ids).fetch_all(&mut *connection).await?;
        let source = rows
            .iter()
            .position(|r| r.id == self.ids[0])
            .ok_or(StoreError::Forbidden)?;
        let target = rows
            .iter()
            .position(|r| r.id == self.ids[1])
            .ok_or(StoreError::Forbidden)?;
        if self.input["expectedRevision"] != rows[source].revision
            || self.input["expectedTargetRevision"] != rows[target].revision
        {
            return Err(StoreError::IssueEditConflict);
        }
        let kind = text(self.input, "kind");
        let action = text(self.input, "action");
        let mut old_parent = None;
        let mut changed = false;
        if kind == "parent" || kind == "child" {
            let (child, parent) = if kind == "parent" {
                (source, target)
            } else {
                (target, source)
            };
            if action == "add" && rows[child].parent_id != Some(rows[parent].id) {
                if let Some(old) = rows[child].parent_id {
                    visible(connection, actor, &[old], true).await?;
                    let old_row: IssueRow = sqlx::query_as(
                        "SELECT i.*,NULL::jsonb AS sla FROM issues i WHERE id=$1 FOR UPDATE",
                    )
                    .bind(old)
                    .fetch_one(&mut *connection)
                    .await?;
                    rows.push(old_row);
                    old_parent = Some(old);
                }
                sqlx::query("UPDATE issues SET parent_id=$1 WHERE id=$2")
                    .bind(rows[parent].id)
                    .bind(rows[child].id)
                    .execute(&mut *connection)
                    .await?;
                changed = true;
            } else if action == "remove" && rows[child].parent_id == Some(rows[parent].id) {
                sqlx::query("UPDATE issues SET parent_id=NULL WHERE id=$1")
                    .bind(rows[child].id)
                    .execute(&mut *connection)
                    .await?;
                changed = true;
            }
        } else {
            let (mut from, mut to) = (self.ids[0], self.ids[1]);
            if kind == "blockedBy" || (kind == "related" && from > to) {
                std::mem::swap(&mut from, &mut to);
            }
            let kind = if kind == "related" {
                "related"
            } else {
                "blocks"
            };
            if action == "remove" {
                changed=sqlx::query("DELETE FROM issue_relations WHERE workspace_id=$1 AND kind=$2 AND ((issue_id=$3 AND related_issue_id=$4) OR ($2='related' AND issue_id=$4 AND related_issue_id=$3))").bind(&actor.workspace_id).bind(kind).bind(from).bind(to).execute(&mut *connection).await?.rows_affected()>0;
            } else {
                let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM issue_relations WHERE workspace_id=$1 AND kind=$2 AND ((issue_id=$3 AND related_issue_id=$4) OR ($2='related' AND issue_id=$4 AND related_issue_id=$3)))").bind(&actor.workspace_id).bind(kind).bind(from).bind(to).fetch_one(&mut *connection).await?;
                if !exists {
                    sqlx::query("INSERT INTO issue_relations(workspace_id,issue_id,related_issue_id,kind) VALUES($1,$2,$3,$4)").bind(&actor.workspace_id).bind(from).bind(to).bind(kind).execute(&mut *connection).await?;
                    changed = true;
                }
            }
        }
        let mut events = vec![];
        if changed {
            let now = iso(Utc::now());
            for row in &rows {
                let action = if Some(row.id) == old_parent {
                    "remove"
                } else {
                    action
                };
                let kind = if Some(row.id) == old_parent {
                    "child"
                } else if row.id == self.ids[0] {
                    kind
                } else {
                    match kind {
                        "parent" => "child",
                        "child" => "parent",
                        "blocks" => "blockedBy",
                        "blockedBy" => "blocks",
                        _ => "related",
                    }
                };
                let label = match kind {
                    "parent" => "parent",
                    "child" => "sub-issue",
                    "related" => "related to",
                    "blocks" => "blocks",
                    _ => "blocked by",
                };
                let mut properties = row.properties.clone();
                let mut activity = properties
                    .get("activity")
                    .map(|v| v.as_array().cloned().ok_or(StoreError::InvalidInput))
                    .transpose()?
                    .unwrap_or_default();
                activity.push(json!({"id":Uuid::new_v4(),"author":actor.user_id,"createdAt":now,"text":format!("{} {label} relationship",if action=="add"{"added"}else{"removed"})}));
                properties["activity"] = json!(activity);
                sqlx::query("UPDATE issues SET properties=$1 WHERE id=$2")
                    .bind(properties)
                    .bind(row.id)
                    .execute(&mut *connection)
                    .await?;
                events.push(OutboxEvent {
                    topic: "issue.relationship-changed".into(),
                    payload: json!({"issueId":row.id,"teamId":row.team_id})
                        .as_object()
                        .unwrap()
                        .clone(),
                });
            }
        }
        Ok(CommandResult {
            value: Related {
                issue_ids: rows.iter().map(|r| r.id).collect(),
            },
            resource_type: "issue".into(),
            resource_id: self.ids[0].to_string(),
            events,
        })
    }
}
pub(super) fn graph_error(error: &StoreError) -> bool {
    matches!(error,StoreError::Database(sqlx::Error::Database(e)) if e.code().as_deref()==Some("23514")&&e.constraint().is_some_and(|s|["issues_parent_acyclic","issues_not_self_parent","issue_relations_blocks_acyclic"].contains(&s)))
}
pub async fn relationship(
    database: &Database,
    actor: &Actor,
    input: Value,
) -> Result<Value, StoreError> {
    let input = contract::relationship_change(input).map_err(|_| StoreError::InvalidInput)?;
    let ids = vec![id(&input, "issueId")?, id(&input, "targetId")?];
    match commands::execute(
        database,
        actor,
        Command {
            key: text(&input, "commandKey"),
            operation: "issues.relationship@1",
            input: &input,
            status: 200,
        },
        &Relationship {
            input: &input,
            ids: ids.clone(),
        },
    )
    .await
    {
        Ok(result) => Ok(
            json!({"status":"saved","replayed":result.replayed,"records":read_current(database,actor,&result.value.issue_ids).await?}),
        ),
        Err(StoreError::IssueEditConflict) => {
            let mut tx = database.begin().await?;
            lock_workspace(&mut tx, &actor.workspace_id, false).await?;
            let current = current_actor(&mut tx, actor).await?;
            visible(&mut tx, &current, &ids, false).await?;
            let records = read_rows(
                &mut tx,
                &current,
                Some(&ids),
                database.sla_gate(&current.workspace_id).0,
            )
            .await?;
            tx.commit().await?;
            Ok(json!({"status":"conflict","records":records}))
        }
        Err(e) if graph_error(&e) => Ok(
            json!({"status":"invalid","message":"This relationship would create a cycle. Choose another issue."}),
        ),
        Err(e) => Err(e),
    }
}
pub async fn relationships(
    database: &Database,
    actor: &Actor,
    input: Value,
) -> Result<Value, StoreError> {
    let input = contract::relationship_query(input).map_err(|_| StoreError::InvalidInput)?;
    let issue = id(&input, "issueId")?;
    let limit = input["limit"].as_i64().ok_or(StoreError::InvalidInput)?;
    let mut tx = database.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let actor = current_actor(&mut tx, actor).await?;
    let summary = visible(&mut tx, &actor, &[issue], false).await?.remove(0);
    sqlx::query("SET LOCAL statement_timeout='5s'")
        .execute(&mut *tx)
        .await?;
    let query = format!(
        r#"WITH edges(kind,target_id) AS (
        SELECT 'parent',parent_id FROM issues WHERE id=$4 AND workspace_id=$1 AND parent_id IS NOT NULL
        UNION SELECT 'child',id FROM issues WHERE parent_id=$4 AND workspace_id=$1
        UNION SELECT kind,related_issue_id FROM issue_relations WHERE issue_id=$4 AND workspace_id=$1 AND kind IN ('related','blocks')
        UNION SELECT CASE WHEN kind='blocks' THEN 'blockedBy' ELSE kind END,issue_id FROM issue_relations WHERE related_issue_id=$4 AND workspace_id=$1 AND kind IN ('related','blocks')
    ),visible AS (SELECT e.kind,i.id,i.title,i.revision,i.team_id AS "teamId",t.slug AS "teamSlug",t.identifier,i.number FROM edges e JOIN issues i ON i.id=e.target_id JOIN teams t ON t.id=i.team_id WHERE i.workspace_id=$1 AND {})
    SELECT jsonb_build_object('resultRevision',(SELECT md5(coalesce(string_agg(jsonb_build_array(kind,id,revision,"teamSlug",identifier)::text,',' ORDER BY kind COLLATE "C",id),'')) FROM visible),'rows',coalesce((SELECT jsonb_agg(p ORDER BY p.kind COLLATE "C",p.id) FROM (SELECT * FROM visible WHERE (kind||':'||id::text) COLLATE "C">$5 COLLATE "C" ORDER BY (kind||':'||id::text) COLLATE "C" LIMIT $6) p),'[]'::jsonb))"#,
        policy::readable_issue("i.id")
    );
    let response: Value = sqlx::query_scalar(&query)
        .bind(&actor.workspace_id)
        .bind(policy::privileged(&actor))
        .bind(&actor.user_id)
        .bind(issue)
        .bind(text(&input, "cursor"))
        .bind(limit + 1)
        .fetch_one(&mut *tx)
        .await?;
    let rows = response["rows"]
        .as_array()
        .ok_or(StoreError::InvalidInput)?;
    let next = if rows.len() > limit as usize {
        let last = &rows[limit as usize - 1];
        Some(format!("{}:{}", text(last, "kind"), text(last, "id")))
    } else {
        None
    };
    let page: Vec<_> = rows
        .iter()
        .take(limit as usize)
        .map(|r| {
            let mut issue = r.clone();
            issue.as_object_mut().unwrap().remove("kind");
            json!({"kind":r["kind"],"issue":issue})
        })
        .collect();
    tx.commit().await?;
    Ok(
        json!({"issue":summary,"resultRevision":response["resultRevision"],"relationships":page,"nextCursor":next}),
    )
}
pub async fn search_relationships(
    database: &Database,
    actor: &Actor,
    input: Value,
) -> Result<Value, StoreError> {
    let input = contract::relationship_search(input).map_err(|_| StoreError::InvalidInput)?;
    let issue = id(&input, "issueId")?;
    let mut tx = database.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let actor = current_actor(&mut tx, actor).await?;
    visible(&mut tx, &actor, &[issue], false).await?;
    sqlx::query("SET LOCAL statement_timeout='5s'")
        .execute(&mut *tx)
        .await?;
    let pattern = format!(
        "%{}%",
        text(&input, "search")
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let after = input
        .get("after")
        .map(|_| id(&input, "after"))
        .transpose()?;
    let query = format!(
        r#"WITH visible AS (SELECT i.id,i.title,i.revision,i.team_id AS "teamId",t.slug AS "teamSlug",t.identifier,i.number FROM issues i JOIN teams t ON t.id=i.team_id WHERE i.workspace_id=$1 AND {} AND i.id<>$4 AND (i.title ILIKE $5 OR (t.identifier||'-'||i.number::text) ILIKE $5)) SELECT jsonb_build_object('resultRevision',(SELECT md5(coalesce(string_agg(jsonb_build_array(id,revision,"teamSlug",identifier)::text,',' ORDER BY id),'')) FROM visible),'rows',coalesce((SELECT jsonb_agg(p ORDER BY p.id) FROM (SELECT * FROM visible WHERE $6::uuid IS NULL OR id>$6 ORDER BY id LIMIT 21) p),'[]'::jsonb))"#,
        policy::readable_issue("i.id")
    );
    let response: Value = sqlx::query_scalar(&query)
        .bind(&actor.workspace_id)
        .bind(policy::privileged(&actor))
        .bind(&actor.user_id)
        .bind(issue)
        .bind(pattern)
        .bind(after)
        .fetch_one(&mut *tx)
        .await?;
    let rows = response["rows"]
        .as_array()
        .ok_or(StoreError::InvalidInput)?;
    let next = if rows.len() > 20 {
        rows[19]["id"].clone()
    } else {
        Value::Null
    };
    tx.commit().await?;
    Ok(
        json!({"issues":rows.iter().take(20).collect::<Vec<_>>(),"resultRevision":response["resultRevision"],"nextCursor":next}),
    )
}
