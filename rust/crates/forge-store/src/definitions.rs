use crate::{
    Database, StoreError,
    authority::current_actor,
    commands::{self, Command, CommandHandler, CommandResult},
    resource_policy as policy,
    workspaces::lock_workspace,
};
use async_trait::async_trait;
use forge_core::{
    actor::{Actor, ApiScope, Authentication},
    definitions::DefinitionValue,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DefinitionCommand {
    pub workspace_id: String,
    pub session_id: String,
    #[serde(deserialize_with = "required_team")]
    pub team_id: Option<String>,
    pub command_key: String,
    pub expected_revision: i32,
    pub value: DefinitionValue,
    #[serde(default)]
    pub status_replacements: HashMap<String, String>,
    #[serde(default)]
    pub label_replacements: HashMap<String, String>,
}
fn required_team<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}
impl DefinitionCommand {
    fn team(&self) -> Result<Option<Uuid>, StoreError> {
        self.team_id.as_deref().map(parse_uuid).transpose()
    }
    fn validate(&self) -> Result<(), StoreError> {
        self.team()?;
        if self.expected_revision < 0
            || self.command_key.is_empty()
            || forge_core::text::length(&self.command_key) > 255
            || self
                .label_replacements
                .iter()
                .any(|(k, v)| !forge_core::text::is_uuid(k) || !forge_core::text::is_uuid(v))
        {
            return Err(StoreError::InvalidInput);
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionSnapshot {
    pub workspace_id: String,
    pub team_id: Option<Uuid>,
    pub revision: i32,
    pub can_manage: bool,
    pub value: DefinitionValue,
}
#[derive(FromRow)]
struct Scope {
    id: Uuid,
    revision: i32,
    value: Value,
}
fn scope_key(team: Option<Uuid>) -> String {
    team.map(|id| id.to_string())
        .unwrap_or_else(|| "workspace".into())
}
fn metadata(value: &Value, key: &str, fallback: Value) -> Value {
    value
        .get(key)
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(fallback)
}
async fn authorize(
    connection: &mut PgConnection,
    actor: &Actor,
    team: Option<Uuid>,
    write: bool,
) -> Result<(), StoreError> {
    policy::scope(actor, ApiScope::IssuesRead)?;
    if write {
        policy::scope(actor, ApiScope::IssuesWrite)?;
        if !policy::privileged(actor) {
            return Err(StoreError::Forbidden);
        }
    }
    if let Some(team) = team {
        policy::team(connection, actor, team).await?;
    }
    Ok(())
}

pub(crate) async fn read_tx(
    connection: &mut PgConnection,
    actor: &Actor,
    team: Option<Uuid>,
) -> Result<DefinitionSnapshot, StoreError> {
    let row:Option<Scope>=sqlx::query_as("SELECT id,revision,value FROM issue_definition_scopes WHERE workspace_id=$1 AND scope_key=$2").bind(&actor.workspace_id).bind(scope_key(team)).fetch_optional(&mut *connection).await?;
    let mut value = row
        .as_ref()
        .map(|r| r.value.clone())
        .unwrap_or_else(|| DefinitionValue::defaults().into_value());
    // Validate saved state before replacing read projections, as the reference does.
    value = DefinitionValue::parse(value)
        .map_err(|_| StoreError::InvalidInput)?
        .into_value();
    if let Some(team) = team {
        let statuses:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name',name,'group',status_group,'description',description,'color',color) FROM issue_statuses WHERE workspace_id=$1 AND team_id=$2 ORDER BY position").bind(&actor.workspace_id).bind(team).fetch_all(&mut *connection).await?;
        value["statuses"]["statuses"] = json!(statuses);
    }
    let labels:Vec<(Uuid,String,Option<Value>)>=sqlx::query_as("SELECT id,name,definition FROM resource_labels WHERE workspace_id=$1 AND team_id IS NOT DISTINCT FROM $2 ORDER BY name").bind(&actor.workspace_id).bind(team).fetch_all(&mut *connection).await?;
    let query = format!(
        "SELECT l.id,count(*) FROM issue_labels a JOIN resource_labels l ON l.id=a.label_id AND l.workspace_id=a.workspace_id JOIN issues i ON i.id=a.issue_id AND i.workspace_id=a.workspace_id WHERE l.workspace_id=$1 AND l.team_id IS NOT DISTINCT FROM $4 AND {} GROUP BY l.id",
        policy::readable_issue(actor, "i.id")
    );
    let counts: Vec<(Uuid, i64)> = sqlx::query_as(&query)
        .bind(&actor.workspace_id)
        .bind(policy::privileged(actor))
        .bind(&actor.user_id)
        .bind(team)
        .fetch_all(&mut *connection)
        .await?;
    let labels:Vec<_>=labels.into_iter().map(|(id,name,definition)|{
        let d=definition.unwrap_or(Value::Null);let count=counts.iter().find(|(key,_)|*key==id).map(|(_,n)|*n).unwrap_or(0);
        json!({"id":id,"name":name,"description":metadata(&d,"description",json!("")),"color":metadata(&d,"color",json!("#5e6ad2")),"groupId":metadata(&d,"groupId",Value::Null),"createdAt":metadata(&d,"createdAt",json!("2026-10-30T00:00:00.000Z")),"lastApplied":null,"archived":metadata(&d,"archived",json!(false)),"issues":count})
    }).collect();
    value["labels"]["labels"] = json!(labels);
    let value = DefinitionValue::parse(value).map_err(|_| StoreError::InvalidInput)?;
    Ok(DefinitionSnapshot {
        workspace_id: actor.workspace_id.clone(),
        team_id: team,
        revision: row.map(|r| r.revision).unwrap_or(0),
        can_manage: policy::privileged(actor) && actor.has_scope(ApiScope::IssuesWrite),
        value,
    })
}
pub async fn read(
    database: &Database,
    actor: &Actor,
    team: Option<Uuid>,
) -> Result<DefinitionSnapshot, StoreError> {
    let mut tx = database.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let live = current_actor(&mut tx, actor).await?;
    authorize(&mut tx, &live, team, false).await?;
    let value = read_tx(&mut tx, &live, team).await?;
    tx.commit().await?;
    Ok(value)
}
pub async fn read_all(database: &Database, actor: &Actor) -> Result<Value, StoreError> {
    let mut tx = database.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let live = current_actor(&mut tx, actor).await?;
    authorize(&mut tx, &live, None, false).await?;
    let teams = policy::team_ids(&mut tx, &live).await?;
    let mut snapshots = vec![read_tx(&mut tx, &live, None).await?];
    for team in teams {
        snapshots.push(read_tx(&mut tx, &live, Some(team)).await?);
    }
    let session = match &live.authentication {
        Authentication::Session { session_id } => session_id.as_str(),
        _ => "",
    };
    let value = json!({"userId":live.user_id,"sessionId":session,"workspaceId":live.workspace_id,"snapshots":snapshots});
    tx.commit().await?;
    Ok(value)
}

pub async fn save(
    database: &Database,
    actor: &Actor,
    input: &DefinitionCommand,
) -> Result<DefinitionSnapshot, StoreError> {
    input.validate()?;
    if input.workspace_id != actor.workspace_id
        || !matches!(&actor.authentication,Authentication::Session{session_id} if session_id==&input.session_id)
    {
        return Err(StoreError::Forbidden);
    }
    let team = input.team()?;
    let mut value = serde_json::to_value(input).map_err(|_| StoreError::InvalidInput)?;
    let object = value.as_object_mut().ok_or(StoreError::InvalidInput)?;
    object.remove("commandKey");
    object.remove("sessionId");
    commands::execute(
        database,
        actor,
        Command {
            key: &input.command_key,
            operation: "issueDefinitions.save@1",
            input: &value,
            status: 200,
        },
        &SaveDefinitions { input, team },
    )
    .await?;
    read(database, actor, team).await
}
struct SaveDefinitions<'a> {
    input: &'a DefinitionCommand,
    team: Option<Uuid>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedDefinitions {
    #[serde(deserialize_with = "required_result_team")]
    team_id: Option<Uuid>,
    revision: i32,
}
fn required_result_team<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Uuid>, D::Error> {
    Option::<String>::deserialize(d)?
        .map(|v| parse_uuid(&v).map_err(serde::de::Error::custom))
        .transpose()
}
#[async_trait]
impl CommandHandler for SaveDefinitions<'_> {
    type Output = SavedDefinitions;
    async fn authorize(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
        _value: Option<&Self::Output>,
    ) -> Result<(), StoreError> {
        authorize(connection, actor, self.team, true).await
    }
    async fn run(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
    ) -> Result<CommandResult<Self::Output>, StoreError> {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,4040))")
            .bind(&actor.workspace_id)
            .execute(&mut *connection)
            .await?;
        sqlx::query("INSERT INTO issue_definition_scopes(workspace_id,team_id,scope_key,value) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING")
            .bind(&actor.workspace_id).bind(self.team).bind(scope_key(self.team)).bind(DefinitionValue::defaults().into_value()).execute(&mut *connection).await?;
        let scope:Scope=sqlx::query_as("SELECT id,revision,value FROM issue_definition_scopes WHERE workspace_id=$1 AND scope_key=$2 FOR UPDATE").bind(&actor.workspace_id).bind(scope_key(self.team)).fetch_one(&mut *connection).await?;
        if scope.revision != self.input.expected_revision {
            return Err(conflict(
                "Definitions changed in another session. Reload and try again.",
            ));
        }
        let previous = read_tx(connection, actor, self.team).await?;
        let next = &self.input.value;
        if self.team.is_none()
            && ["statuses", "workflows", "transitions"]
                .iter()
                .any(|key| next.as_value()[key] != previous.value.as_value()[key])
        {
            return Err(StoreError::InvalidInput);
        }
        let removed_statuses: Vec<_> = previous
            .value
            .statuses()
            .iter()
            .filter(|old| !next.statuses().iter().any(|new| new["id"] == old["id"]))
            .collect();
        let removed_labels: Vec<_> = previous
            .value
            .labels()
            .iter()
            .filter(|old| !next.labels().iter().any(|new| new["id"] == old["id"]))
            .collect();
        for (source, target) in &self.input.status_replacements {
            if !removed_statuses.iter().any(|s| s["id"] == *source)
                || !next.statuses().iter().any(|s| s["id"] == *target)
            {
                return Err(StoreError::InvalidInput);
            }
        }
        for (source, target) in &self.input.label_replacements {
            if !removed_labels.iter().any(|s| s["id"] == *source)
                || !next
                    .labels()
                    .iter()
                    .any(|s| s["id"] == *target && s["archived"] != true)
            {
                return Err(StoreError::InvalidInput);
            }
        }
        protect_saved_references(
            connection,
            actor,
            self.team,
            &previous.value,
            next,
            &removed_labels,
        )
        .await?;
        if let Some(team) = self.team {
            for (position, status) in next.statuses().iter().enumerate() {
                sqlx::query("INSERT INTO issue_statuses(workspace_id,team_id,id,name,status_group,description,color,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,team_id,id) DO UPDATE SET name=excluded.name,status_group=excluded.status_group,description=excluded.description,color=excluded.color,position=excluded.position")
                    .bind(&actor.workspace_id).bind(team).bind(status["id"].as_str()).bind(status["name"].as_str()).bind(status["group"].as_str()).bind(status["description"].as_str()).bind(status["color"].as_str()).bind(position as i32).execute(&mut *connection).await?;
            }
            sqlx::query("SELECT set_config('forge.definition_migration','true',true)")
                .execute(&mut *connection)
                .await?;
            for removed in removed_statuses {
                let id = removed["id"].as_str().ok_or(StoreError::InvalidInput)?;
                if let Some(target) = self.input.status_replacements.get(id) {
                    sqlx::query("UPDATE issues SET status_id=$1 WHERE workspace_id=$2 AND team_id=$3 AND status_id=$4").bind(target).bind(&actor.workspace_id).bind(team).bind(id).execute(&mut *connection).await?;
                } else {
                    let used:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM issues WHERE workspace_id=$1 AND team_id=$2 AND status_id=$3)").bind(&actor.workspace_id).bind(team).bind(id).fetch_one(&mut *connection).await?;
                    if used {
                        return Err(conflict(
                            "This status is assigned to issues. Choose a replacement before deleting it.",
                        ));
                    }
                }
                sqlx::query(
                    "DELETE FROM issue_statuses WHERE workspace_id=$1 AND team_id=$2 AND id=$3",
                )
                .bind(&actor.workspace_id)
                .bind(team)
                .bind(id)
                .execute(&mut *connection)
                .await?;
            }
        }
        for label in next.labels() {
            let id = Uuid::parse_str(label["id"].as_str().ok_or(StoreError::InvalidInput)?)
                .map_err(|_| StoreError::InvalidInput)?;
            let old: Option<(String, Option<Uuid>)> = sqlx::query_as(
                "SELECT workspace_id,team_id FROM resource_labels WHERE id=$1 FOR SHARE",
            )
            .bind(id)
            .fetch_optional(&mut *connection)
            .await?;
            if old.is_some_and(|(workspace, team)| {
                workspace != actor.workspace_id || team != self.team
            }) {
                return Err(StoreError::Forbidden);
            }
            let mut definition = label.clone();
            definition["issues"] = json!(0);
            definition["lastApplied"] = Value::Null;
            let affected=sqlx::query("INSERT INTO resource_labels(id,workspace_id,team_id,name,definition) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,definition=excluded.definition WHERE resource_labels.workspace_id=$2 AND resource_labels.team_id IS NOT DISTINCT FROM $3")
                .bind(id).bind(&actor.workspace_id).bind(self.team).bind(label["name"].as_str()).bind(definition).execute(&mut *connection).await?;
            if affected.rows_affected() != 1 {
                return Err(StoreError::Forbidden);
            }
        }
        for removed in removed_labels {
            let id = Uuid::parse_str(removed["id"].as_str().ok_or(StoreError::InvalidInput)?)
                .map_err(|_| StoreError::InvalidInput)?;
            if let Some(target) = self
                .input
                .label_replacements
                .get(removed["id"].as_str().unwrap())
            {
                let target = Uuid::parse_str(target).map_err(|_| StoreError::InvalidInput)?;
                sqlx::query("INSERT INTO issue_labels(workspace_id,issue_id,label_id) SELECT workspace_id,issue_id,$1 FROM issue_labels WHERE workspace_id=$2 AND label_id=$3 ON CONFLICT(issue_id,label_id) DO NOTHING").bind(target).bind(&actor.workspace_id).bind(id).execute(&mut *connection).await?;
                sqlx::query("DELETE FROM issue_labels WHERE workspace_id=$1 AND label_id=$2")
                    .bind(&actor.workspace_id)
                    .bind(id)
                    .execute(&mut *connection)
                    .await?;
            } else {
                let used:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM issue_labels WHERE workspace_id=$1 AND label_id=$2)").bind(&actor.workspace_id).bind(id).fetch_one(&mut *connection).await?;
                if used {
                    return Err(conflict(
                        "This label is assigned to issues. Choose a replacement or archive it.",
                    ));
                }
            }
            sqlx::query("DELETE FROM resource_labels WHERE workspace_id=$1 AND id=$2")
                .bind(&actor.workspace_id)
                .bind(id)
                .execute(&mut *connection)
                .await?;
        }
        sqlx::query("UPDATE issue_definition_scopes SET revision=revision+1,value=$1 WHERE id=$2")
            .bind(next.as_value())
            .bind(scope.id)
            .execute(connection)
            .await?;
        Ok(CommandResult {
            value: SavedDefinitions {
                team_id: self.team,
                revision: scope.revision + 1,
            },
            resource_type: "issueDefinitions".into(),
            resource_id: scope.id.to_string(),
            events: vec![],
        })
    }
}
fn conflict(message: &'static str) -> StoreError {
    StoreError::DefinitionConflict(message)
}

async fn protect_saved_references(
    connection: &mut PgConnection,
    actor: &Actor,
    team: Option<Uuid>,
    previous: &DefinitionValue,
    next: &DefinitionValue,
    removed_labels: &[&Value],
) -> Result<(), StoreError> {
    let records:Vec<(Option<Uuid>,Value)>=sqlx::query_as("SELECT team_id,payload FROM team_templates WHERE workspace_id=$1 UNION ALL SELECT team_id,payload FROM team_recurring_issues WHERE workspace_id=$1").bind(&actor.workspace_id).fetch_all(connection).await?;
    for (record_team, payload) in &records {
        let mut properties = Vec::new();
        if payload["kind"] != "project" {
            properties.push(payload.get("properties").ok_or(StoreError::InvalidInput)?);
        }
        if let Some(issues) = payload.get("issues") {
            for issue in issues.as_array().ok_or(StoreError::InvalidInput)? {
                properties.push(issue.get("properties").ok_or(StoreError::InvalidInput)?);
            }
        }
        for issue in payload
            .get("subIssues")
            .and_then(Value::as_array)
            .ok_or(StoreError::InvalidInput)?
        {
            properties.push(issue.get("properties").ok_or(StoreError::InvalidInput)?);
        }
        for property in properties {
            let property_team = property["teamIds"]
                .as_array()
                .ok_or(StoreError::InvalidInput)?
                .first()
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| record_team.map(|id| id.to_string()));
            if team.is_some() && property_team == team.map(|id| id.to_string()) {
                let status = property["status"]
                    .as_str()
                    .ok_or(StoreError::InvalidInput)?;
                if previous.statuses().iter().any(|old| {
                    (old["id"] == status || old["name"] == status)
                        && (!next.statuses().iter().any(|new| new["id"] == old["id"])
                            || (old["name"] == status
                                && next
                                    .statuses()
                                    .iter()
                                    .find(|new| new["id"] == old["id"])
                                    .is_none_or(|new| new["name"] != old["name"])))
                }) {
                    return Err(conflict(
                        "This status is used by a saved template or recurring issue. Update it there before renaming or deleting it.",
                    ));
                }
            }
            let labels = property["labels"]
                .as_array()
                .ok_or(StoreError::InvalidInput)?;
            if removed_labels
                .iter()
                .any(|removed| labels.iter().any(|id| id == &removed["id"]))
            {
                return Err(conflict(
                    "This label is used by a saved template or recurring issue. Update it there before deleting it.",
                ));
            }
        }
    }
    Ok(())
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Classification {
    #[serde(deserialize_with = "uuid_value")]
    pub issue_id: Uuid,
    pub command_key: String,
    pub expected_status_id: String,
    pub status_id: String,
    #[serde(deserialize_with = "uuid_values")]
    pub label_ids: Vec<Uuid>,
}
fn parse_uuid(value: &str) -> Result<Uuid, StoreError> {
    if !forge_core::text::is_uuid(value) {
        return Err(StoreError::InvalidInput);
    }
    Uuid::parse_str(value).map_err(|_| StoreError::InvalidInput)
}
fn uuid_value<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Uuid, D::Error> {
    parse_uuid(&String::deserialize(d)?).map_err(serde::de::Error::custom)
}
fn uuid_values<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<Uuid>, D::Error> {
    Vec::<String>::deserialize(d)?
        .iter()
        .map(|v| parse_uuid(v).map_err(serde::de::Error::custom))
        .collect()
}
pub async fn classify(
    database: &Database,
    actor: &Actor,
    input: &Classification,
) -> Result<Value, StoreError> {
    if input.command_key.is_empty()
        || forge_core::text::length(&input.command_key) > 255
        || input.expected_status_id.is_empty()
        || input.status_id.is_empty()
        || input.label_ids.len() > 100
        || input
            .label_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != input.label_ids.len()
    {
        return Err(StoreError::InvalidInput);
    }
    let mut value = serde_json::to_value(input).map_err(|_| StoreError::InvalidInput)?;
    value.as_object_mut().unwrap().remove("commandKey");
    Ok(json!(
        commands::execute(
            database,
            actor,
            Command {
                key: &input.command_key,
                operation: "issues.classify@1",
                input: &value,
                status: 200,
            },
            &Classify { input },
        )
        .await?
        .value
    ))
}
struct Classify<'a> {
    input: &'a Classification,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClassifiedIssue {
    #[serde(deserialize_with = "uuid_value")]
    issue_id: Uuid,
}
#[async_trait]
impl CommandHandler for Classify<'_> {
    type Output = ClassifiedIssue;
    async fn authorize(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
        _value: Option<&Self::Output>,
    ) -> Result<(), StoreError> {
        policy::scope(actor, ApiScope::IssuesRead)?;
        policy::scope(actor, ApiScope::IssuesWrite)?;
        policy::issue(connection, actor, self.input.issue_id, false).await?;
        Ok(())
    }
    async fn run(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
    ) -> Result<CommandResult<Self::Output>, StoreError> {
        let identity = policy::issue(connection, actor, self.input.issue_id, false).await?;
        sqlx::query("INSERT INTO issue_definition_scopes(workspace_id,team_id,scope_key,value) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING")
            .bind(&actor.workspace_id).bind(identity.team_id).bind(identity.team_id.to_string()).bind(DefinitionValue::defaults().into_value()).execute(&mut *connection).await?;
        let value:Value=sqlx::query_scalar("SELECT value FROM issue_definition_scopes WHERE workspace_id=$1 AND team_id=$2 FOR SHARE").bind(&actor.workspace_id).bind(identity.team_id).fetch_one(&mut *connection).await?;
        let definitions = DefinitionValue::parse(value).map_err(|_| StoreError::InvalidInput)?;
        let issue = policy::issue(connection, actor, self.input.issue_id, true).await?;
        if issue.team_id != identity.team_id || issue.status_id != self.input.expected_status_id {
            return Err(conflict(
                "This issue's status changed. Reload before moving it.",
            ));
        }
        if !definitions
            .statuses()
            .iter()
            .any(|s| s["id"] == self.input.status_id)
            || !definitions.can_transition(&issue.status_id, &self.input.status_id)
        {
            return Err(StoreError::InvalidInput);
        }
        let previous: Vec<Uuid> = sqlx::query_scalar(
            "SELECT label_id FROM issue_labels WHERE workspace_id=$1 AND issue_id=$2",
        )
        .bind(&actor.workspace_id)
        .bind(issue.id)
        .fetch_all(&mut *connection)
        .await?;
        let labels:Vec<(Uuid,Option<Uuid>,Option<Value>)>=sqlx::query_as("SELECT id,team_id,definition FROM resource_labels WHERE workspace_id=$1 AND id=ANY($2) FOR SHARE").bind(&actor.workspace_id).bind(&self.input.label_ids).fetch_all(&mut *connection).await?;
        if labels.len() != self.input.label_ids.len()
            || labels.iter().any(|(id, team, definition)| {
                team.is_some_and(|t| t != issue.team_id)
                    || (definition.as_ref().is_some_and(|d| d["archived"] == true)
                        && !previous.contains(id))
            })
        {
            return Err(StoreError::InvalidInput);
        }
        sqlx::query("UPDATE issues SET status_id=$1 WHERE id=$2")
            .bind(&self.input.status_id)
            .bind(issue.id)
            .execute(&mut *connection)
            .await?;
        sqlx::query("DELETE FROM issue_labels WHERE workspace_id=$1 AND issue_id=$2")
            .bind(&actor.workspace_id)
            .bind(issue.id)
            .execute(&mut *connection)
            .await?;
        for label in &self.input.label_ids {
            sqlx::query(
                "INSERT INTO issue_labels(workspace_id,issue_id,label_id) VALUES($1,$2,$3)",
            )
            .bind(&actor.workspace_id)
            .bind(issue.id)
            .bind(label)
            .execute(&mut *connection)
            .await?;
        }
        Ok(CommandResult {
            value: ClassifiedIssue { issue_id: issue.id },
            resource_type: "issue".into(),
            resource_id: issue.id.to_string(),
            events: vec![],
        })
    }
}
