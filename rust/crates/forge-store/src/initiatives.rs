//! Shared initiatives, including the workspace configuration gate and visible rollups.
use crate::{
    Database, StoreError,
    authority::current_actor,
    commands::{self, Command, CommandHandler, CommandResult, OutboxEvent},
    projects, resource_policy as policy,
    workspaces::lock_workspace,
};
use async_trait::async_trait;
use chrono::{SecondsFormat, Utc};
use forge_core::{
    actor::{Actor, Authentication},
    initiatives as contract,
    projects::array,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection};
use std::collections::BTreeSet;
use uuid::Uuid;
#[derive(Clone, Copy, Default)]
pub struct InitiativeOptions {
    pub enabled: bool,
}
impl InitiativeOptions {
    pub fn from_env() -> Self {
        Self {
            enabled: std::env::var("FORGE_FEATURE_INITIATIVES").as_deref() == Ok("true"),
        }
    }
}
fn invalid(message: &'static str) -> StoreError {
    StoreError::Planning(message)
}
fn parse(value: Result<Value, forge_core::planning::PlanningError>) -> Result<Value, StoreError> {
    value.map_err(|e| invalid(e.0))
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}
fn id(v: &Value, k: &str) -> Result<Uuid, StoreError> {
    text(v, k).parse().map_err(|_| StoreError::InvalidInput)
}
fn session(a: &Actor) -> Result<(), StoreError> {
    if matches!(a.authentication, Authentication::Session { .. }) && a.scopes.is_none() {
        Ok(())
    } else {
        Err(StoreError::Forbidden)
    }
}
async fn fence(c: &mut PgConnection, a: &Actor) -> Result<(), StoreError> {
    sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
        .bind(&a.workspace_id)
        .fetch_optional(c)
        .await?
        .ok_or(StoreError::Forbidden)?;
    Ok(())
}
fn key(a: &Actor) -> String {
    format!("forge:workspace:{}:initiatives-settings:v1", a.workspace_id)
}
#[derive(FromRow)]
struct Settings {
    id: Uuid,
    encoded_value: Option<String>,
    revision: i32,
}
pub(crate) async fn settings(
    c: &mut PgConnection,
    a: &Actor,
    options: InitiativeOptions,
) -> Result<Value, StoreError> {
    let row:Option<Settings>=sqlx::query_as("SELECT id,encoded_value,revision FROM product_state WHERE workspace_id=$1 AND owner_id='workspace' AND key=$2").bind(&a.workspace_id).bind(key(a)).fetch_optional(c).await?;
    let raw = if let Some(encoded) = row.as_ref().and_then(|r| r.encoded_value.as_deref()) {
        let raw: String = serde_json::from_str(encoded).map_err(|_| StoreError::InvalidInput)?;
        serde_json::from_str(&raw).map_err(|_| StoreError::InvalidInput)?
    } else {
        json!({"enabled":true,"schedule":"none"})
    };
    let mut effective = parse(contract::settings(raw.clone()))?;
    effective["enabled"] = json!(options.enabled && effective["enabled"] == true);
    Ok(
        json!({"settings":effective,"storedSettings":raw,"revision":row.map_or(0,|r|r.revision),"canManage":policy::privileged(a)}),
    )
}
#[derive(FromRow)]
struct Row {
    id: Uuid,
    name: String,
    number: i32,
    revision: i32,
    properties: Value,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    #[serde(deserialize_with = "one")]
    revision: u8,
}
fn one<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u8, D::Error> {
    let v = u8::deserialize(d)?;
    if v == 1 {
        Ok(v)
    } else {
        Err(serde::de::Error::custom("initiative receipt"))
    }
}
struct Save<'a> {
    changes: &'a Value,
    options: InitiativeOptions,
}
pub(crate) async fn apply_changes(
    c: &mut PgConnection,
    a: &Actor,
    changes: Value,
    options: InitiativeOptions,
) -> Result<Vec<OutboxEvent>, StoreError> {
    let changes = parse(contract::changes(changes))?;
    let handler = Save {
        changes: &changes,
        options,
    };
    handler.authorize(c, a, None).await?;
    Ok(handler.run(c, a).await?.events)
}
#[async_trait]
impl CommandHandler for Save<'_> {
    type Output = Saved;
    async fn authorize(
        &self,
        c: &mut PgConnection,
        a: &Actor,
        _: Option<&Saved>,
    ) -> Result<(), StoreError> {
        session(a)?;
        fence(c, a).await?;
        if settings(c, a, self.options).await?["settings"]["enabled"] != true {
            return Err(StoreError::Forbidden);
        }
        for change in self.changes.as_array().unwrap() {
            if !change["expectedRevision"].is_null() {
                sqlx::query("SELECT id FROM initiatives WHERE workspace_id=$1 AND id=$2")
                    .bind(&a.workspace_id)
                    .bind(id(change, "id")?)
                    .fetch_optional(&mut *c)
                    .await?
                    .ok_or(StoreError::Forbidden)?;
            }
            let ids: BTreeSet<_> = array(change, "addProjectIds")
                .iter()
                .chain(array(change, "removeProjectIds"))
                .map(|v| v.as_str().unwrap())
                .collect();
            for id in ids {
                projects::lock_project(c, a, id.parse().map_err(|_| StoreError::InvalidInput)?)
                    .await?;
            }
        }
        Ok(())
    }
    async fn run(
        &self,
        c: &mut PgConnection,
        a: &Actor,
    ) -> Result<CommandResult<Saved>, StoreError> {
        for change in self.changes.as_array().unwrap() {
            let id = id(change, "id")?;
            let old:Option<Row>=sqlx::query_as("SELECT id,name,number,revision,properties FROM initiatives WHERE workspace_id=$1 AND id=$2 FOR UPDATE").bind(&a.workspace_id).bind(id).fetch_optional(&mut *c).await?;
            if if change["expectedRevision"].is_null() {
                old.is_some()
            } else {
                old.as_ref()
                    .is_none_or(|r| change["expectedRevision"] != r.revision)
            } {
                return Err(invalid(
                    "This initiative changed in another session. Your draft is preserved. Load the latest shared version and review your changes.",
                ));
            }
            let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
            let before = old
                .as_ref()
                .map(|r| r.properties.clone())
                .unwrap_or(json!({}));
            let mut input = contract::blank(&a.user_id, &now);
            input
                .as_object_mut()
                .unwrap()
                .extend(before.as_object().unwrap().clone());
            input
                .as_object_mut()
                .unwrap()
                .extend(change["changes"].as_object().unwrap().clone());
            if change["changes"].get("name").is_none() {
                if let Some(old) = &old {
                    input["name"] = json!(old.name);
                } else {
                    input.as_object_mut().unwrap().remove("name");
                }
            }
            let mut properties = parse(contract::fields(input, false, false))?;
            if !text(&properties, "ownerId").is_empty()
                && (old.is_none() || change["changes"].get("ownerId").is_some())
            {
                sqlx::query(
                    "SELECT id FROM member WHERE organization_id=$1 AND user_id=$2 FOR SHARE",
                )
                .bind(&a.workspace_id)
                .bind(text(&properties, "ownerId"))
                .fetch_optional(&mut *c)
                .await?
                .ok_or(StoreError::Forbidden)?;
            }
            if array(&properties, "updates")
                .iter()
                .chain(array(&properties, "comments"))
                .chain(
                    array(&properties, "updates")
                        .iter()
                        .flat_map(|u| array(u, "comments")),
                )
                .any(|e| !array(e, "attachments").is_empty())
            {
                return Err(invalid("Initiative attachments are not available yet."));
            }
            for key in ["updates", "comments"] {
                let mut entries = forge_core::projects::reconcile(
                    a,
                    array(&before, key),
                    array(&properties, key),
                    &now,
                )
                .map_err(|e| {
                    if e.0 == "forbidden" {
                        StoreError::Forbidden
                    } else {
                        invalid(e.0)
                    }
                })?;
                entries.reverse();
                properties[key] = json!(entries);
            }
            // Reparse after reconciliation, keeping initiative comments flat and updates threaded.
            properties = parse(contract::fields(properties, false, false))?;
            properties["creatorId"] = before
                .get("creatorId")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(json!(a.user_id));
            properties["createdAt"] = before
                .get("createdAt")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(json!(now));
            properties["updatedAt"] = json!(now);
            properties["completedAt"] = if properties["status"] == "Completed" {
                before
                    .get("completedAt")
                    .filter(|v| !v.is_null())
                    .cloned()
                    .unwrap_or(json!(now))
            } else {
                Value::Null
            };
            if old.is_some() {
                sqlx::query("UPDATE initiatives SET name=$1,properties=$2 WHERE id=$3")
                    .bind(text(&properties, "name"))
                    .bind(&properties)
                    .bind(id)
                    .execute(&mut *c)
                    .await?;
            } else {
                sqlx::query("INSERT INTO initiatives(id,workspace_id,name,number,revision,properties) VALUES($1,$2,$3,(SELECT coalesce(max(number),0)+1 FROM initiatives WHERE workspace_id=$2),1,$4)").bind(id).bind(&a.workspace_id).bind(text(&properties,"name")).bind(&properties).execute(&mut *c).await?;
            }
            if array(change, "addProjectIds")
                .iter()
                .any(|p| array(change, "removeProjectIds").contains(p))
            {
                return Err(invalid("A project cannot be added and removed together."));
            }
            let removed: Vec<Uuid> = array(change, "removeProjectIds")
                .iter()
                .map(|v| v.as_str().unwrap().parse().unwrap())
                .collect();
            if !removed.is_empty() {
                sqlx::query(
                    "DELETE FROM initiative_projects WHERE initiative_id=$1 AND project_id=ANY($2)",
                )
                .bind(id)
                .bind(removed)
                .execute(&mut *c)
                .await?;
            }
            let added: BTreeSet<Uuid> = array(change, "addProjectIds")
                .iter()
                .map(|v| v.as_str().unwrap().parse().unwrap())
                .collect();
            for project in added {
                sqlx::query("INSERT INTO initiative_projects(workspace_id,initiative_id,project_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(&a.workspace_id).bind(id).bind(project).execute(&mut *c).await?;
            }
        }
        Ok(CommandResult {
            value: Saved { revision: 1 },
            resource_type: "initiative".into(),
            resource_id: text(&self.changes[0], "id").into(),
            events: self
                .changes
                .as_array()
                .unwrap()
                .iter()
                .map(|c| OutboxEvent {
                    topic: "initiative.updated".into(),
                    payload: json!({"initiativeId":c["id"]}).as_object().unwrap().clone(),
                })
                .collect(),
        })
    }
}
pub async fn save(
    db: &Database,
    a: &Actor,
    key: &str,
    changes: Value,
    options: InitiativeOptions,
) -> Result<Value, StoreError> {
    let changes = contract::changes(changes).map_err(|_| StoreError::InvalidInput)?;
    let result = commands::execute(
        db,
        a,
        Command {
            key,
            operation: "initiatives.save@1",
            input: &changes,
            status: 200,
        },
        &Save {
            changes: &changes,
            options,
        },
    )
    .await?;
    Ok(json!({"value":result.value,"replayed":result.replayed}))
}
pub(crate) async fn snapshot(
    c: &mut PgConnection,
    a: &Actor,
    options: InitiativeOptions,
) -> Result<Value, StoreError> {
    session(a)?;
    if settings(c, a, options).await?["settings"]["enabled"] != true {
        return Ok(contract::empty());
    }
    let rows:Vec<Row>=sqlx::query_as("SELECT id,name,number,revision,properties FROM initiatives WHERE workspace_id=$1 ORDER BY number").bind(&a.workspace_id).fetch_all(&mut *c).await?;
    let links: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT initiative_id,project_id FROM initiative_projects WHERE workspace_id=$1",
    )
    .bind(&a.workspace_id)
    .fetch_all(&mut *c)
    .await?;
    let selected: Vec<Uuid> = links.iter().map(|(_, id)| *id).collect();
    let projects = projects::snapshot(c, a, Some(&selected)).await?;
    let q = format!(
        "SELECT i.project_id,count(*)::bigint,count(*) FILTER (WHERE EXISTS(SELECT 1 FROM issue_statuses s WHERE s.workspace_id=i.workspace_id AND s.team_id=i.team_id AND s.id=i.status_id AND s.status_group='completed'))::bigint FROM issues i WHERE i.workspace_id=$1 AND {} AND {} GROUP BY i.project_id",
        policy::readable_project("i.project_id"),
        policy::readable_issue("i.id")
    );
    let counts: Vec<(Uuid, i64, i64)> = sqlx::query_as(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .fetch_all(c)
        .await?;
    let next = rows
        .iter()
        .map(|r| i64::from(r.number) + 1)
        .max()
        .unwrap_or(1);
    let mut items = vec![];
    for row in rows {
        let children: Vec<_> = projects
            .iter()
            .filter(|p| {
                links
                    .iter()
                    .any(|(i, project)| *i == row.id && p["id"] == project.to_string())
            })
            .cloned()
            .collect();
        let visible: Vec<_> = counts
            .iter()
            .filter(|(id, _, _)| children.iter().any(|p| p["id"] == id.to_string()))
            .collect();
        let total: i64 = visible.iter().map(|(_, n, _)| n).sum();
        let completed: i64 = visible.iter().map(|(_, _, n)| n).sum();
        let mut p = contract::blank("", "1970-01-01T00:00:00.000Z");
        p.as_object_mut()
            .unwrap()
            .extend(row.properties.as_object().unwrap().clone());
        p["id"] = json!(row.id);
        p["number"] = json!(row.number);
        p["revision"] = json!(row.revision);
        p["name"] = json!(row.name);
        p["rollup"] = json!({"projectCount":children.len(),"completedProjects":children.iter().filter(|p|p["status"]=="Completed").count(),"issueCount":total,"completedIssues":completed,"percent":if total>0{(completed as f64/total as f64*100.0).round() as i64}else{0}});
        p["projects"] = json!(children);
        for key in ["teamIds", "labelIds", "resources", "views"] {
            p[key] = json!([]);
        }
        items.push(parse(contract::initiative(p))?);
    }
    Ok(json!({"version":1,"nextNumber":next,"initiatives":items,"workspaceProjects":[]}))
}
pub async fn read(
    db: &Database,
    a: &Actor,
    options: InitiativeOptions,
) -> Result<Value, StoreError> {
    let mut tx = db.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    lock_workspace(&mut tx, &a.workspace_id, false).await?;
    let a = current_actor(&mut tx, a).await?;
    let result = snapshot(&mut tx, &a, options).await?;
    tx.commit().await?;
    Ok(result)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedSettings {
    revision: i32,
}
struct SaveSettings<'a> {
    input: &'a Value,
}
#[async_trait]
impl CommandHandler for SaveSettings<'_> {
    type Output = SavedSettings;
    async fn authorize(
        &self,
        c: &mut PgConnection,
        a: &Actor,
        _: Option<&SavedSettings>,
    ) -> Result<(), StoreError> {
        session(a)?;
        if !policy::privileged(a) {
            return Err(StoreError::Forbidden);
        }
        fence(c, a).await
    }
    async fn run(
        &self,
        c: &mut PgConnection,
        a: &Actor,
    ) -> Result<CommandResult<SavedSettings>, StoreError> {
        let key = key(a);
        sqlx::query("INSERT INTO product_state(workspace_id,owner_id,key,encoded_value) VALUES($1,'workspace',$2,NULL) ON CONFLICT DO NOTHING").bind(&a.workspace_id).bind(&key).execute(&mut *c).await?;
        let row:Settings=sqlx::query_as("SELECT id,encoded_value,revision FROM product_state WHERE workspace_id=$1 AND owner_id='workspace' AND key=$2 FOR UPDATE").bind(&a.workspace_id).bind(&key).fetch_one(&mut *c).await?;
        if self.input["expectedRevision"] != row.revision {
            let prior = row
                .encoded_value
                .as_ref()
                .map(|r| serde_json::from_str::<Value>(r))
                .transpose()
                .map_err(|_| StoreError::InvalidInput)?
                .unwrap_or(Value::Null);
            if prior == self.input["value"] {
                return Ok(CommandResult {
                    value: SavedSettings {
                        revision: row.revision,
                    },
                    resource_type: "productState".into(),
                    resource_id: row.id.to_string(),
                    events: vec![],
                });
            }
            return Err(invalid(
                "This data changed in another session. Your pending changes are preserved in this session; reload the latest version before retrying.",
            ));
        }
        sqlx::query("UPDATE product_state SET encoded_value=$1,revision=revision+1 WHERE id=$2")
            .bind(if self.input["value"].is_null() {
                None
            } else {
                Some(self.input["value"].to_string())
            })
            .bind(row.id)
            .execute(c)
            .await?;
        Ok(CommandResult {
            value: SavedSettings {
                revision: row.revision + 1,
            },
            resource_type: "productState".into(),
            resource_id: row.id.to_string(),
            events: vec![],
        })
    }
}
pub async fn save_settings(db: &Database, a: &Actor, input: Value) -> Result<Value, StoreError> {
    let input = contract::settings_command(input).map_err(|_| StoreError::InvalidInput)?;
    let payload = json!({"workspaceId":a.workspace_id,"key":key(a),"value":input["value"],"expectedRevision":input["expectedRevision"]});
    let result = commands::execute(
        db,
        a,
        Command {
            key: text(&input, "commandKey"),
            operation: "productState.save@1",
            input: &payload,
            status: 200,
        },
        &SaveSettings { input: &input },
    )
    .await?;
    Ok(json!({"value":result.value,"replayed":result.replayed}))
}
pub async fn read_settings(
    db: &Database,
    a: &Actor,
    options: InitiativeOptions,
) -> Result<Value, StoreError> {
    let mut tx = db.begin().await?;
    lock_workspace(&mut tx, &a.workspace_id, false).await?;
    let a = current_actor(&mut tx, a).await?;
    session(&a)?;
    let value = settings(&mut tx, &a, options).await?;
    tx.commit().await?;
    Ok(value)
}
