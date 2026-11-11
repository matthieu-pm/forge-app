mod comments;
mod engagement;
mod relationships;
pub use relationships::{relationship, relationships, search_relationships};
mod history;
pub use engagement::engagement;
pub use history::history;
mod edit;
mod fields;
use crate::{
    Database, StoreError,
    authority::current_actor,
    commands::{self, Command, CommandHandler, CommandResult, OutboxEvent},
    resource_policy as policy,
    workspaces::lock_workspace,
};
use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat, Utc};
pub use comments::{comment, mentions};
pub use edit::edit;
use forge_core::{
    actor::{Actor, ApiScope, Authentication},
    canonical::command_input_hash,
    issues::{self as contract, CreateIssue},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn id(value: &Value, key: &str) -> Result<Uuid, StoreError> {
    Uuid::parse_str(text(value, key)).map_err(|_| StoreError::InvalidInput)
}
fn invalid(message: &'static str) -> StoreError {
    StoreError::IssueValidation(message)
}
fn iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn session(actor: &Actor) -> &str {
    match &actor.authentication {
        Authentication::Session { session_id } => session_id,
        _ => "",
    }
}
#[derive(Clone, Copy, Default)]
pub struct IssueOptions {
    pub personal_preferences: bool,
    pub assign_started: bool,
}
impl IssueOptions {
    pub fn from_env() -> Self {
        let personal_preferences =
            std::env::var("FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED").is_ok_and(|v| v == "true");
        Self {
            personal_preferences,
            assign_started: personal_preferences
                && std::env::var("FORGE_ASSIGN_STARTED_ISSUES_ENABLED").is_ok_and(|v| v == "true"),
        }
    }
}

#[derive(FromRow)]
struct IssueRow {
    id: Uuid,
    team_id: Uuid,
    revision: i32,
    number: i32,
    title: String,
    status_id: String,
    assignee_id: Option<String>,
    creator_id: Option<String>,
    project_id: Option<Uuid>,
    parent_id: Option<Uuid>,
    cycle_id: Option<Uuid>,
    legacy_id: Option<String>,
    properties: Value,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    sla: Option<Value>,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IssueRecord {
    pub team_id: Uuid,
    pub legacy_id: Option<String>,
    pub issue: Value,
}
async fn read_rows(
    connection: &mut PgConnection,
    actor: &Actor,
    ids: Option<&[Uuid]>,
) -> Result<Vec<IssueRecord>, StoreError> {
    policy::scope(actor, ApiScope::IssuesRead)?;
    let query = format!(
        "SELECT i.id,i.team_id,i.revision,i.number,i.title,i.status_id,i.assignee_id,i.creator_id,CASE WHEN {} THEN i.project_id ELSE NULL END project_id,CASE WHEN {} THEN i.parent_id ELSE NULL END parent_id,i.cycle_id,i.legacy_id,i.properties,i.created_at,i.updated_at,{} sla FROM issues i WHERE i.workspace_id=$1 AND {} AND ($4::uuid[] IS NULL OR i.id=ANY($4)) ORDER BY i.number",
        policy::readable_project("i.project_id"),
        policy::readable_issue("i.parent_id"),
        if commands::sla_gate(&actor.workspace_id).0 {
            "forge_sla_snapshot(i.id)"
        } else {
            "NULL::jsonb"
        },
        policy::readable_issue("i.id")
    );
    let rows: Vec<IssueRow> = sqlx::query_as(&query)
        .bind(&actor.workspace_id)
        .bind(policy::privileged(actor))
        .bind(&actor.user_id)
        .bind(ids)
        .fetch_all(&mut *connection)
        .await?;
    let row_ids: Vec<_> = rows.iter().map(|r| r.id).collect();
    let labels:Vec<(Uuid,String)>=sqlx::query_as("SELECT a.issue_id,l.name FROM issue_labels a JOIN resource_labels l ON l.id=a.label_id WHERE a.issue_id=ANY($1) ORDER BY l.name").bind(&row_ids).fetch_all(&mut *connection).await?;
    let cycle_query = format!(
        "SELECT c.id FROM issue_cycles c WHERE c.workspace_id=$1 AND {}",
        policy::readable_team("c.team_id")
    );
    let cycles: Vec<Uuid> = sqlx::query_scalar(&cycle_query)
        .bind(&actor.workspace_id)
        .bind(policy::privileged(actor))
        .bind(&actor.user_id)
        .fetch_all(&mut *connection)
        .await?;
    rows.into_iter()
        .map(|r| {
            let mut value = contract::blank(&r.status_id);
            let props = r.properties.as_object().ok_or(StoreError::InvalidInput)?;
            value.as_object_mut().unwrap().extend(props.clone());
            if let Some(sla) = r.sla {
                value["sla"] = sla;
            }
            let mut comments = value["comments"]
                .as_array()
                .ok_or(StoreError::InvalidInput)?
                .clone();
            for c in &mut comments {
                if c["deleted"] == true {
                    c["body"] = json!("");
                    c.as_object_mut()
                        .ok_or(StoreError::InvalidInput)?
                        .remove("document");
                    c["attachments"] = json!([]);
                    c["reactions"] = json!([]);
                }
            }
            value["comments"] = json!(comments);
            for (key, v) in [
                ("id", json!(r.id)),
                ("revision", json!(r.revision)),
                ("number", json!(r.number)),
                ("title", json!(r.title)),
                ("status", json!(r.status_id)),
                ("assignee", json!(r.assignee_id.unwrap_or_default())),
                (
                    "project",
                    json!(r.project_id.map(|id| id.to_string()).unwrap_or_default()),
                ),
                (
                    "parentId",
                    json!(r.parent_id.map(|id| id.to_string()).unwrap_or_default()),
                ),
                (
                    "cycle",
                    json!(
                        r.cycle_id
                            .filter(|id| cycles.contains(id))
                            .map(|id| id.to_string())
                            .unwrap_or_default()
                    ),
                ),
                (
                    "labels",
                    json!(
                        labels
                            .iter()
                            .filter(|(id, _)| *id == r.id)
                            .map(|(_, s)| s.as_str())
                            .collect::<Vec<_>>()
                            .join(",")
                    ),
                ),
                ("creator", json!(r.creator_id.unwrap_or_default())),
                ("createdAt", json!(iso(r.created_at))),
                ("updatedAt", json!(iso(r.updated_at))),
                (
                    "statusChangedAt",
                    if !text(&r.properties, "status").is_empty() {
                        r.properties
                            .get("statusChangedAt")
                            .filter(|v| !v.is_null())
                            .cloned()
                            .unwrap_or(json!(iso(r.created_at)))
                    } else {
                        json!(iso(r.created_at))
                    },
                ),
                ("suggestedLabel", json!("")),
                (
                    "completedAt",
                    r.properties
                        .get("completedAt")
                        .cloned()
                        .unwrap_or(Value::Null),
                ),
            ] {
                value[key] = v;
            }
            Ok(IssueRecord {
                team_id: r.team_id,
                legacy_id: r.legacy_id,
                issue: contract::team_issue(value).map_err(|_| StoreError::InvalidInput)?,
            })
        })
        .collect()
}
pub async fn read(
    database: &Database,
    actor: &Actor,
    metadata_only: bool,
) -> Result<Value, StoreError> {
    let mut tx = database.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let actor = current_actor(&mut tx, actor).await?;
    policy::scope(&actor, ApiScope::IssuesRead)?;
    let query = format!(
        "SELECT jsonb_build_object('id',p.id,'workspaceId',p.workspace_id,'name',p.name,'legacyId',p.legacy_id,'revision',p.revision,'properties',p.properties) FROM projects p WHERE p.workspace_id=$1 AND {} AND $4",
        policy::readable_project("p.id")
    );
    let mut projects: Vec<Value> = sqlx::query_scalar(&query)
        .bind(&actor.workspace_id)
        .bind(policy::privileged(&actor))
        .bind(&actor.user_id)
        .bind(actor.has_scope(ApiScope::ProjectsRead))
        .fetch_all(&mut *tx)
        .await?;
    let query = format!(
        "SELECT p.project_id,p.team_id FROM project_teams p WHERE p.workspace_id=$1 AND {}",
        policy::readable_team("p.team_id")
    );
    let links: Vec<(Uuid, Uuid)> = sqlx::query_as(&query)
        .bind(&actor.workspace_id)
        .bind(policy::privileged(&actor))
        .bind(&actor.user_id)
        .fetch_all(&mut *tx)
        .await?;
    let project_ids: Vec<String> = projects
        .iter()
        .flat_map(|p| {
            [p["id"].as_str(), p["legacyId"].as_str()]
                .into_iter()
                .flatten()
                .map(str::to_owned)
        })
        .collect();
    for p in &mut projects {
        p["properties"]["teamIds"] = json!(
            links
                .iter()
                .filter(|(id, _)| id.to_string() == text(p, "id"))
                .map(|(_, id)| id)
                .collect::<Vec<_>>()
        );
        p["properties"]["dependencyIds"] = json!(
            p["properties"]["dependencyIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|v| v
                    .as_str()
                    .is_some_and(|s| project_ids.iter().any(|id| id == s)))
                .collect::<Vec<_>>()
        );
    }
    let query = format!(
        "SELECT jsonb_build_object('id',c.id,'workspaceId',c.workspace_id,'teamId',c.team_id,'number',c.number,'timezone',c.timezone,'startDate',c.start_date,'endDate',c.end_date) FROM issue_cycles c WHERE c.workspace_id=$1 AND {}",
        policy::readable_team("c.team_id")
    );
    let cycles: Vec<Value> = sqlx::query_scalar(&query)
        .bind(&actor.workspace_id)
        .bind(policy::privileged(&actor))
        .bind(&actor.user_id)
        .fetch_all(&mut *tx)
        .await?;
    let records = if metadata_only {
        vec![]
    } else {
        read_rows(&mut tx, &actor, None).await?
    };
    let value = json!({"workspaceId":actor.workspace_id,"userId":actor.user_id,"sessionId":session(&actor),"records":records,"projects":projects,"cycles":cycles});
    tx.commit().await?;
    Ok(value)
}
async fn read_current(
    database: &Database,
    actor: &Actor,
    ids: &[Uuid],
) -> Result<Vec<IssueRecord>, StoreError> {
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let live = current_actor(&mut tx, actor).await?;
    let rows = read_rows(&mut tx, &live, Some(ids)).await?;
    tx.commit().await?;
    Ok(rows)
}
async fn mutation_fence(connection: &mut PgConnection, actor: &Actor) -> Result<(), StoreError> {
    sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
        .bind(&actor.workspace_id)
        .fetch_optional(connection)
        .await?
        .ok_or(StoreError::Forbidden)?;
    Ok(())
}
async fn definition_fence(connection: &mut PgConnection, actor: &Actor) -> Result<(), StoreError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,4040))")
        .bind(&actor.workspace_id)
        .execute(connection)
        .await?;
    Ok(())
}
async fn next_number(
    connection: &mut PgConnection,
    team: Uuid,
    count: usize,
) -> Result<i32, StoreError> {
    sqlx::query("INSERT INTO team_issue_numbers(team_id) VALUES($1) ON CONFLICT DO NOTHING")
        .bind(team)
        .execute(&mut *connection)
        .await?;
    let last:i32=sqlx::query_scalar("UPDATE team_issue_numbers SET last_number=last_number+$2 WHERE team_id=$1 RETURNING last_number").bind(team).bind(count as i32).fetch_one(connection).await?;
    Ok(last - count as i32 + 1)
}
fn assignment_activity(actor: &Actor, assignee: Option<&str>, now: &str) -> Value {
    assignee.filter(|s|!s.is_empty()).map_or(json!([]),|id|json!([{"id":Uuid::new_v4(),"author":actor.user_id,"text":format!("assigned to {id}"),"createdAt":now,"field":"assignee","to":id}]))
}
fn created_event(
    actor: &Actor,
    id: Uuid,
    team: Uuid,
    assignee: Option<&str>,
    imported: bool,
) -> OutboxEvent {
    let _ = actor;
    OutboxEvent{topic:"issue.created".into(),payload:json!({"issueId":id,"teamId":team,"history":{"version":1,"origin":if imported{"import"}else{"command"},"changes":assignee.filter(|s|!s.is_empty()).map_or(json!([]),|id|json!([{"field":"assignee","from":"","to":id}]))}}).as_object().unwrap().clone()}
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreatedIssue {
    issue_id: Uuid,
    child_ids: Vec<Uuid>,
}
struct Create<'a> {
    input: &'a Value,
    team: Uuid,
    options: IssueOptions,
    legacy_fingerprint: Option<String>,
}
#[async_trait]
impl CommandHandler for Create<'_> {
    type Output = CreatedIssue;
    async fn authorize(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
        value: Option<&CreatedIssue>,
    ) -> Result<(), StoreError> {
        mutation_fence(connection, actor).await?;
        fields::require_team(connection, actor, self.team).await?;
        if let Some(value) = value {
            for id in std::iter::once(&value.issue_id).chain(&value.child_ids) {
                policy::issue(connection, actor, *id, false).await?;
            }
        }
        Ok(())
    }
    async fn run(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
    ) -> Result<CommandResult<CreatedIssue>, StoreError> {
        definition_fence(connection, actor).await?;
        let draft = &self.input["draft"];
        let legacy = self.input.get("legacyId").and_then(Value::as_str);
        if let Some(legacy) = legacy {
            let existing:Option<(Uuid,Value)>=sqlx::query_as("SELECT id,properties FROM issues WHERE workspace_id=$1 AND team_id=$2 AND legacy_id=$3").bind(&actor.workspace_id).bind(self.team).bind(legacy).fetch_optional(&mut *connection).await?;
            if let Some((id, props)) = existing {
                if props["legacyFingerprint"].as_str() != self.legacy_fingerprint.as_deref() {
                    return Err(invalid(
                        "A different version of this imported issue is already shared. Your source snapshot is preserved on the server.",
                    ));
                }
                return Ok(CommandResult {
                    value: CreatedIssue {
                        issue_id: id,
                        child_ids: vec![],
                    },
                    resource_type: "issue".into(),
                    resource_id: id.to_string(),
                    events: vec![],
                });
            }
        }
        let resolved =
            fields::resolve(connection, actor, self.team, self.input, None, self.options).await?;
        let children = draft["subIssues"].as_array().unwrap();
        let number = next_number(connection, self.team, 1 + children.len()).await?;
        let now = Utc::now();
        let timestamp = iso(now);
        let issue = Uuid::new_v4();
        let mut properties = draft.clone();
        if let Some(hash) = &self.legacy_fingerprint {
            properties["legacyFingerprint"] = json!(hash);
        }
        for (key, value) in [
            ("milestone", json!(resolved.milestone)),
            (
                "attachments",
                if legacy.is_some() {
                    draft.get("attachments").cloned().unwrap_or(Value::Null)
                } else {
                    json!([])
                },
            ),
            (
                "assignee",
                json!(resolved.assignee.as_deref().unwrap_or("")),
            ),
            ("subIssues", json!([])),
            (
                "activity",
                assignment_activity(actor, resolved.assignee.as_deref(), &timestamp),
            ),
            ("comments", json!([])),
            ("reactions", json!([])),
            ("favorite", json!(false)),
            ("subscribers", json!(actor.user_id)),
            (
                "completedAt",
                if resolved.status["group"] == "completed" {
                    json!(timestamp)
                } else {
                    Value::Null
                },
            ),
            ("statusChangedAt", json!(timestamp)),
        ] {
            properties[key] = value;
        }
        if legacy.is_some() && draft.get("attachments").is_none() {
            properties.as_object_mut().unwrap().remove("attachments");
        }
        sqlx::query("INSERT INTO issues(id,workspace_id,team_id,number,title,status_id,project_id,parent_id,cycle_id,assignee_id,creator_id,properties,legacy_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)").bind(issue).bind(&actor.workspace_id).bind(self.team).bind(number).bind(text(draft,"title")).bind(text(&resolved.status,"id")).bind(resolved.project_id).bind(resolved.parent_id).bind(resolved.cycle_id).bind(&resolved.assignee).bind(&actor.user_id).bind(&properties).bind(legacy).bind(now).execute(&mut *connection).await?;
        if legacy.is_none()
            && draft["attachments"]
                .as_array()
                .is_some_and(|a| !a.is_empty())
        {
            if !matches!(actor.authentication, Authentication::Session { .. }) {
                return Err(StoreError::Forbidden);
            }
            let job = json!({"issueId":issue,"teamId":self.team,"creationKey":self.input["commandKey"],"files":draft["attachments"],"next":0,"completed":false,"attempts":{},"sessions":[]});
            let encoded =
                serde_json::to_string(&job.to_string()).map_err(|_| StoreError::InvalidInput)?;
            sqlx::query("INSERT INTO product_state(workspace_id,owner_id,owner_user_id,key,encoded_value) VALUES($1,$2,$3,$4,$5)").bind(&actor.workspace_id).bind(format!("user:{}",actor.user_id)).bind(&actor.user_id).bind(format!("forge:file-draft:v1:{issue}:creation")).bind(encoded).execute(&mut *connection).await?;
        }
        write_labels(connection, actor, issue, &resolved.labels).await?;
        let mut child_ids = Vec::new();
        let mut events = vec![created_event(
            actor,
            issue,
            self.team,
            resolved.assignee.as_deref(),
            legacy.is_some(),
        )];
        for (index, title) in children.iter().enumerate() {
            let child = Uuid::new_v4();
            let mut props = contract::blank(text(&resolved.status, "id"));
            props["assignee"] = json!(resolved.personal_assignee.as_deref().unwrap_or(""));
            props["activity"] =
                assignment_activity(actor, resolved.personal_assignee.as_deref(), &timestamp);
            props["completedAt"] = if resolved.status["group"] == "completed" {
                json!(timestamp)
            } else {
                Value::Null
            };
            props["statusChangedAt"] = json!(timestamp);
            sqlx::query("INSERT INTO issues(id,workspace_id,team_id,number,title,status_id,parent_id,creator_id,assignee_id,properties,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)").bind(child).bind(&actor.workspace_id).bind(self.team).bind(number+index as i32+1).bind(title.as_str()).bind(text(&resolved.status,"id")).bind(issue).bind(&actor.user_id).bind(&resolved.personal_assignee).bind(props).bind(now).execute(&mut *connection).await?;
            child_ids.push(child);
            events.push(created_event(
                actor,
                child,
                self.team,
                resolved.personal_assignee.as_deref(),
                legacy.is_some(),
            ));
        }
        Ok(CommandResult {
            value: CreatedIssue {
                issue_id: issue,
                child_ids,
            },
            resource_type: "issue".into(),
            resource_id: issue.to_string(),
            events,
        })
    }
}
async fn write_labels(
    connection: &mut PgConnection,
    actor: &Actor,
    issue: Uuid,
    labels: &[Uuid],
) -> Result<(), StoreError> {
    for label in labels {
        sqlx::query("INSERT INTO issue_labels(workspace_id,issue_id,label_id) VALUES($1,$2,$3)")
            .bind(&actor.workspace_id)
            .bind(issue)
            .bind(label)
            .execute(&mut *connection)
            .await?;
    }
    Ok(())
}
pub async fn create(
    database: &Database,
    actor: &Actor,
    input: &CreateIssue,
    options: IssueOptions,
) -> Result<Value, StoreError> {
    let input = input.as_value();
    let team = id(input, "teamId")?;
    let mut payload = input.clone();
    payload.as_object_mut().unwrap().remove("commandKey");
    let legacy_fingerprint = if input.get("legacyId").is_some() {
        Some(command_input_hash(
            &contract::legacy_source(&input["draft"], input.get("assigneeId"))
                .map_err(|_| StoreError::InvalidInput)?,
        ))
    } else {
        None
    };
    let result = commands::execute(
        database,
        actor,
        Command {
            key: text(input, "commandKey"),
            operation: "issues.create@1",
            input: &payload,
            status: 201,
        },
        &Create {
            input,
            team,
            options,
            legacy_fingerprint,
        },
    )
    .await?;
    let ids: Vec<_> = std::iter::once(result.value.issue_id)
        .chain(result.value.child_ids.iter().copied())
        .collect();
    let records = read_current(database, actor, &ids).await?;
    let issue = records
        .iter()
        .find(|r| text(&r.issue, "id") == result.value.issue_id.to_string())
        .ok_or(StoreError::NotFound)?
        .issue
        .clone();
    Ok(json!({"replayed":result.replayed,"value":result.value,"issue":issue,"records":records}))
}
