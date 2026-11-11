use super::*;
use forge_core::issues::EditIssues;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EditedIssues {
    issue_ids: Vec<Uuid>,
}
struct Edit<'a> {
    database: &'a Database,
    input: &'a Value,
    team: Uuid,
    ids: Vec<Uuid>,
    options: IssueOptions,
}
fn js_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(js_text).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        v => v.to_string(),
    }
}
pub(super) fn bounded(v: &str, limit: usize) -> String {
    let mut n = 0;
    v.chars()
        .take_while(|c| {
            n += c.len_utf16();
            n <= limit
        })
        .collect()
}
#[async_trait]
impl CommandHandler for Edit<'_> {
    type Output = EditedIssues;
    async fn authorize(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
        value: Option<&EditedIssues>,
    ) -> Result<(), StoreError> {
        mutation_fence(connection, actor).await?;
        fields::require_team(connection, actor, self.team).await?;
        for id in value.map_or(&self.ids, |v| &v.issue_ids) {
            if policy::issue(connection, actor, *id, false).await?.team_id != self.team {
                return Err(StoreError::Forbidden);
            }
        }
        Ok(())
    }
    async fn run(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
    ) -> Result<CommandResult<EditedIssues>, StoreError> {
        definition_fence(connection, actor).await?;
        sqlx::query("SELECT public.forge_lock_issue_graph($1)")
            .bind(&actor.workspace_id)
            .execute(&mut *connection)
            .await?;
        let rows:Vec<IssueRow>=sqlx::query_as("SELECT i.*,NULL::jsonb AS sla FROM issues i WHERE i.workspace_id=$1 AND i.team_id=$2 AND i.id=ANY($3) AND i.archived_at IS NULL ORDER BY i.id FOR UPDATE").bind(&actor.workspace_id).bind(self.team).bind(&self.ids).fetch_all(&mut *connection).await?;
        if rows.len() != self.ids.len() {
            return Err(StoreError::Forbidden);
        }
        let edits = self.input["edits"].as_array().unwrap();
        if edits.iter().any(|e| {
            rows.iter()
                .find(|r| r.id.to_string() == text(e, "issueId"))
                .is_none_or(|r| e["expectedRevision"] != r.revision)
        }) {
            return Err(StoreError::IssueEditConflict);
        }
        let originals = read_rows(
            connection,
            actor,
            Some(&self.ids),
            self.database.sla_gate(&actor.workspace_id).0,
        )
        .await?;
        let mut created = vec![];
        let mut events = vec![];
        for edit in edits {
            let issue_id = id(edit, "issueId")?;
            let row = rows
                .iter()
                .find(|r| r.id == issue_id)
                .ok_or(StoreError::Forbidden)?;
            let before = &originals
                .iter()
                .find(|r| text(&r.issue, "id") == issue_id.to_string())
                .ok_or(StoreError::Forbidden)?
                .issue;
            let changes = &edit["changes"];
            if let Some(parent) = changes.get("parentId")
                && parent.as_str()
                    != Some(&row.parent_id.map(|id| id.to_string()).unwrap_or_default())
            {
                return Err(invalid(
                    "Use relationship controls to change an issue's parent.",
                ));
            }
            let decision = edit.get("triageDecision").and_then(Value::as_str);
            if decision.is_some() && before["triage"] != true {
                return Err(StoreError::IssueEditConflict);
            }
            if decision.is_some()
                && (text(changes, "status").is_empty()
                    || (decision == Some("accept")
                        && !changes.as_object().unwrap().contains_key("assignee"))
                    || changes
                        .as_object()
                        .unwrap()
                        .keys()
                        .any(|key| key != "status" && key != "assignee"))
            {
                return Err(invalid(
                    "Choose a triage status and assignment before deciding.",
                ));
            }
            let mut draft = before.clone();
            draft
                .as_object_mut()
                .unwrap()
                .extend(changes.as_object().unwrap().clone());
            draft["subIssues"] = json!([]);
            if decision.is_some() {
                draft["triage"] = json!(false);
                draft["snoozed"] = json!(false);
            }
            let mut input =
                json!({"teamId":self.team,"commandKey":self.input["commandKey"],"draft":draft});
            for key in ["projectImport", "cycleImport"] {
                if let Some(v) = edit.get(key) {
                    input[key] = v.clone();
                }
            }
            let resolved = fields::resolve(
                connection,
                actor,
                self.team,
                &input,
                Some((before, changes.get("assignee").is_some())),
                self.options,
            )
            .await?;
            if let Some(decision) = decision
                && if decision == "decline" {
                    resolved.status["group"] != "canceled"
                } else {
                    !["backlog", "unstarted", "started"].contains(&text(&resolved.status, "group"))
                }
            {
                return Err(invalid("Choose a valid status for this triage decision."));
            }
            draft["assignee"] = json!(resolved.assignee.as_deref().unwrap_or(""));
            let now = iso(Utc::now());
            let mut activity = before["activity"]
                .as_array()
                .ok_or(StoreError::InvalidInput)?
                .clone();
            for (field, value) in changes.as_object().unwrap() {
                if field == "subIssues" {
                    continue;
                }
                let automatic = field == "status" && resolved.assigned_on_start;
                let mut item = json!({"id":Uuid::new_v4(),"author":actor.user_id,"text":if automatic{format!("moved to {} and self-assigned the issue",text(&resolved.status,"name"))}else{format!("updated {field}")},"createdAt":now});
                if automatic {
                    item["automaticAssignment"] = json!({"from":"","to":actor.user_id});
                }
                if [
                    "status", "priority", "assignee", "labels", "project", "cycle",
                ]
                .contains(&field.as_str())
                {
                    item["field"] = json!(field);
                    item["from"] = json!(js_text(&before[field]));
                    item["to"] = json!(js_text(value));
                }
                activity.push(item);
            }
            if let Some(decision) = decision {
                activity.push(json!({"id":Uuid::new_v4(),"author":actor.user_id,"text":if decision=="accept"{"accepted from triage"}else{"declined from triage"},"createdAt":now}));
            }
            let mut properties = row.properties.clone();
            properties
                .as_object_mut()
                .ok_or(StoreError::InvalidInput)?
                .extend(draft.as_object().unwrap().clone());
            properties["milestone"] = json!(resolved.milestone);
            for key in ["comments", "reactions"] {
                properties[key] = row.properties.get(key).cloned().unwrap_or(json!([]));
            }
            properties["subscribers"] = row
                .properties
                .get("subscribers")
                .cloned()
                .unwrap_or(json!(""));
            properties["activity"] = json!(activity);
            properties["subIssues"] = json!([]);
            sqlx::query("UPDATE issues SET title=$1,status_id=$2,assignee_id=$3,project_id=$4,cycle_id=$5,parent_id=$6,properties=$7 WHERE id=$8").bind(text(&draft,"title")).bind(text(&resolved.status,"id")).bind(&resolved.assignee).bind(resolved.project_id).bind(resolved.cycle_id).bind(if changes.get("parentId").is_none(){row.parent_id}else{resolved.parent_id}).bind(properties).bind(issue_id).execute(&mut *connection).await?;
            sqlx::query("DELETE FROM issue_labels WHERE workspace_id=$1 AND issue_id=$2")
                .bind(&actor.workspace_id)
                .bind(issue_id)
                .execute(&mut *connection)
                .await?;
            write_labels(connection, actor, issue_id, &resolved.labels).await?;
            let mut history = changes.clone();
            if before["milestone"] != resolved.milestone {
                history["milestone"] = json!(resolved.milestone);
            }
            let mut history:Vec<Value>=history.as_object().unwrap().iter().filter(|(field,value)|field.as_str()!="subIssues"&&!(field.as_str()=="descriptionDoc"&&changes.get("description").is_some())&&before[*field]!=**value).map(|(field,value)|{let retain=["status","priority","assignee","project","labels","dueDate","cycle","parentId","recurrence","subscribers","milestone","triage","snoozed"].contains(&field.as_str());json!({"field":if field=="descriptionDoc"{"description"}else{field},"from":if retain{bounded(&js_text(&before[field]),1000)}else{String::new()},"to":if retain{bounded(&js_text(value),1000)}else{String::new()}})}).collect();
            if resolved.assigned_on_start {
                history.push(json!({"field":"assignee","from":"","to":actor.user_id}));
            }
            events.push(OutboxEvent{topic:"issue.updated".into(),payload:json!({"issueId":issue_id,"teamId":self.team,"history":{"version":1,"changes":history}}).as_object().unwrap().clone()});
            if let Some(decision) = decision {
                events.push(OutboxEvent {
                    topic: if decision == "accept" {
                        "issue.triage.accepted"
                    } else {
                        "issue.triage.declined"
                    }
                    .into(),
                    payload: json!({"issueId":issue_id,"teamId":self.team})
                        .as_object()
                        .unwrap()
                        .clone(),
                });
            }
            let children = changes["subIssues"].as_array().cloned().unwrap_or_default();
            if !children.is_empty() {
                let first = next_number(connection, self.team, children.len()).await?;
                for (index, title) in children.into_iter().enumerate() {
                    let mut child_draft = contract::blank(text(&draft, "status"));
                    child_draft["title"] = title.clone();
                    child_draft["parentId"] = json!(issue_id);
                    let child_input = json!({"teamId":self.team,"commandKey":self.input["commandKey"],"draft":child_draft});
                    let child_resolved = fields::resolve(
                        connection,
                        actor,
                        self.team,
                        &child_input,
                        None,
                        self.options,
                    )
                    .await?;
                    child_draft["assignee"] =
                        json!(child_resolved.assignee.as_deref().unwrap_or(""));
                    child_draft["activity"] =
                        assignment_activity(actor, child_resolved.assignee.as_deref(), &now);
                    let child = Uuid::new_v4();
                    sqlx::query("INSERT INTO issues(id,workspace_id,team_id,number,title,status_id,parent_id,assignee_id,creator_id,properties) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").bind(child).bind(&actor.workspace_id).bind(self.team).bind(first+index as i32).bind(title.as_str()).bind(text(&draft,"status")).bind(issue_id).bind(&child_resolved.assignee).bind(&actor.user_id).bind(child_draft).execute(&mut *connection).await?;
                    created.push(child);
                    events.push(created_event(
                        actor,
                        child,
                        self.team,
                        child_resolved.assignee.as_deref(),
                        false,
                    ));
                }
            }
        }
        Ok(CommandResult {
            value: EditedIssues {
                issue_ids: self.ids.iter().copied().chain(created).collect(),
            },
            resource_type: "issueBatch".into(),
            resource_id: self.ids[0].to_string(),
            events,
        })
    }
}
pub async fn edit(
    database: &Database,
    actor: &Actor,
    input: &EditIssues,
    options: IssueOptions,
) -> Result<Value, StoreError> {
    let input = input.as_value();
    let team = id(input, "teamId")?;
    let ids = input["edits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| id(e, "issueId"))
        .collect::<Result<Vec<_>, _>>()?;
    let payload = json!({"teamId":input["teamId"],"edits":input["edits"]});
    match commands::execute(
        database,
        actor,
        Command {
            key: text(input, "commandKey"),
            operation: "issues.edit@1",
            input: &payload,
            status: 200,
        },
        &Edit {
            database,
            input,
            team,
            ids: ids.clone(),
            options,
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
            fields::require_team(&mut tx, &current, team).await?;
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
        Err(error) => Err(error),
    }
}
