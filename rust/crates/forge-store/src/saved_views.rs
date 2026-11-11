//! Saved views retain every rule and recheck live references before execution.
use crate::{
    Database, StoreError,
    authority::current_actor,
    commands::{self, Command, CommandHandler, CommandResult, OutboxEvent},
    projects, resource_policy as policy,
    workspaces::lock_workspace,
};
use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat, Utc};
use forge_core::{
    actor::{Actor, Authentication},
    saved_views as contract,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection};
use std::{
    collections::HashSet,
    sync::atomic::{AtomicBool, Ordering},
};
use uuid::Uuid;
const UNAVAILABLE: &str = "This view has unsupported filters or unavailable references. Review its filters before using it.";
#[derive(Clone, Copy, Default)]
pub struct ViewOptions {
    pub enabled: bool,
}
impl ViewOptions {
    pub fn from_env() -> Self {
        Self {
            enabled: std::env::var("FORGE_FEATURE_SAVED_VIEWS").as_deref() == Ok("true"),
        }
    }
}
fn session(a: &Actor) -> Result<(), StoreError> {
    if matches!(a.authentication, Authentication::Session { .. }) {
        Ok(())
    } else {
        Err(StoreError::Forbidden)
    }
}
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}
fn identity(s: &str) -> Result<Uuid, StoreError> {
    if !forge_core::text::is_uuid(s) {
        return Err(StoreError::Planning(UNAVAILABLE));
    }
    s.parse().map_err(|_| StoreError::Planning(UNAVAILABLE))
}
fn visibility() -> String {
    let team = policy::readable_team("v.team_id");
    format!(
        "v.workspace_id=$1 AND (v.owner_id=$3 OR v.visibility='workspace' OR (v.visibility='team' AND {team})) AND (v.team_id IS NULL OR {team})"
    )
}
async fn fence(c: &mut PgConnection, a: &Actor) -> Result<(), StoreError> {
    sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
        .bind(&a.workspace_id)
        .fetch_one(c)
        .await?;
    Ok(())
}
#[derive(FromRow)]
struct Row {
    id: Uuid,
    workspace_id: String,
    owner_id: String,
    visibility: String,
    team_id: Option<Uuid>,
    revision: i32,
    definition: Value,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    deleted_at: Option<DateTime<Utc>>,
}
fn editable(a: &Actor, row: &Row) -> bool {
    row.owner_id == a.user_id || (row.visibility != "personal" && policy::privileged(a))
}
async fn check(
    c: &mut PgConnection,
    a: &Actor,
    kind: &str,
    id: &str,
    lock: bool,
) -> Result<(), StoreError> {
    if id.is_empty() {
        return Ok(());
    }
    if kind == "member" {
        let q = format!(
            "SELECT id FROM member WHERE organization_id=$1 AND user_id=$2 {}",
            if lock { "FOR SHARE" } else { "" }
        );
        sqlx::query(&q)
            .bind(&a.workspace_id)
            .bind(id)
            .fetch_optional(c)
            .await?
            .ok_or(StoreError::Planning(UNAVAILABLE))?;
        return Ok(());
    }
    let id = identity(id)?;
    if lock {
        return match kind {
            "team" => policy::team(c, a, id).await,
            "project" => projects::lock_project(c, a, id).await,
            "issue" => {
                let row = policy::issue(c, a, id, false).await?;
                sqlx::query("SELECT id FROM issues WHERE id=$1 FOR SHARE")
                    .bind(id)
                    .fetch_one(&mut *c)
                    .await?;
                policy::team(c, a, row.team_id).await
            }
            _ => unreachable!(),
        }
        .map_err(|e| {
            if matches!(e, StoreError::Forbidden) {
                StoreError::Planning(UNAVAILABLE)
            } else {
                e
            }
        });
    }
    let (table, condition) = match kind {
        "team" => ("teams", policy::readable_team("r.id")),
        "project" => ("projects", policy::readable_project("r.id")),
        "issue" => ("issues", policy::readable_issue("r.id")),
        _ => unreachable!(),
    };
    let q = format!("SELECT r.id FROM {table} r WHERE r.id=$4 AND {condition}");
    sqlx::query(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .bind(id)
        .fetch_optional(c)
        .await?
        .ok_or(StoreError::Planning(UNAVAILABLE))?;
    Ok(())
}
pub async fn validate_references(
    c: &mut PgConnection,
    a: &Actor,
    definition: &Value,
    lock: bool,
) -> Result<(), StoreError> {
    if let Some(team) = definition["teamId"].as_str() {
        check(c, a, "team", team, lock).await?;
    }
    if definition["kind"] == "issues" {
        for rule in forge_core::projects::array(&definition["filters"], "rules") {
            if ["set", "notSet"].contains(&text(rule, "operator")) || text(rule, "value").is_empty()
            {
                continue;
            }
            let kind = match text(rule, "field") {
                "project" => "project",
                "parentId" => "issue",
                "assignee" | "creator" | "subscribers" => "member",
                _ => continue,
            };
            check(c, a, kind, text(rule, "value"), lock).await?;
        }
    } else {
        for rule in forge_core::projects::array(definition, "filters") {
            if rule["field"] == "Initiatives" {
                return Err(StoreError::Planning(
                    "Initiative filters are unavailable until shared initiatives are enabled.",
                ));
            }
            let kind = match text(rule, "field") {
                "Teams" => "team",
                "Specific project" => "project",
                "Lead" | "Members" => "member",
                _ => continue,
            };
            check(c, a, kind, text(rule, "value"), lock).await?;
        }
    }
    Ok(())
}
pub async fn read(db: &Database, a: &Actor, options: ViewOptions) -> Result<Value, StoreError> {
    session(a)?;
    let mut tx = db.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    lock_workspace(&mut tx, &a.workspace_id, false).await?;
    let a = current_actor(&mut tx, a).await?;
    let mut result = json!({"workspaceId":a.workspace_id,"userId":a.user_id,"sessionId":match &a.authentication{Authentication::Session{session_id}=>session_id.as_str(),_=>""},"enabled":options.enabled,"views":[],"error":""});
    if !options.enabled {
        tx.commit().await?;
        return Ok(result);
    }
    let q = format!(
        "SELECT v.* FROM saved_views v WHERE {} AND v.deleted_at IS NULL ORDER BY v.id LIMIT 501",
        visibility()
    );
    let rows: Vec<Row> = sqlx::query_as(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(&a))
        .bind(&a.user_id)
        .fetch_all(&mut *tx)
        .await?;
    if rows.len() > 500 {
        result["error"] = json!("The first 500 saved views are shown.");
    }
    let favorites: Vec<Uuid> = sqlx::query_scalar(
        "SELECT view_id FROM saved_view_favorites WHERE workspace_id=$1 AND user_id=$2",
    )
    .bind(&a.workspace_id)
    .bind(&a.user_id)
    .fetch_all(&mut *tx)
    .await?;
    for row in rows.iter().take(500) {
        let Ok(mut definition) = contract::definition(row.definition.clone()) else {
            result["error"] = json!(UNAVAILABLE);
            continue;
        };
        if definition["visibility"] != row.visibility
            || definition
                .get("teamId")
                .and_then(Value::as_str)
                .map(str::to_owned)
                != row.team_id.map(|id| id.to_string())
            || validate_references(&mut tx, &a, &definition, false)
                .await
                .is_err()
        {
            result["error"] = json!(UNAVAILABLE);
            continue;
        }
        definition.as_object_mut().unwrap().remove("version");
        definition.as_object_mut().unwrap().extend(json!({"id":row.id,"ownerId":row.owner_id,"favorite":favorites.contains(&row.id),"revision":row.revision,"canEdit":editable(&a,row),"createdAt":row.created_at.to_rfc3339_opts(SecondsFormat::Millis,true),"updatedAt":row.updated_at.to_rfc3339_opts(SecondsFormat::Millis,true)}).as_object().unwrap().clone());
        result["views"].as_array_mut().unwrap().push(definition);
    }
    tx.commit().await?;
    Ok(result)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    #[serde(deserialize_with = "saved_id")]
    id: String,
    #[serde(deserialize_with = "nonnegative")]
    revision: i32,
}
fn saved_id<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let s = String::deserialize(d)?;
    if forge_core::text::is_uuid(&s) {
        Ok(s)
    } else {
        Err(serde::de::Error::custom("UUID"))
    }
}
fn nonnegative<'de, D: serde::Deserializer<'de>>(d: D) -> Result<i32, D::Error> {
    let n = i32::deserialize(d)?;
    if n >= 0 {
        Ok(n)
    } else {
        Err(serde::de::Error::custom("nonnegative revision"))
    }
}
struct Mutation<'a> {
    input: &'a Value,
    id: Uuid,
    privatized: AtomicBool,
}
#[async_trait]
impl CommandHandler for Mutation<'_> {
    type Output = Saved;
    async fn authorize(
        &self,
        c: &mut PgConnection,
        a: &Actor,
        saved: Option<&Saved>,
    ) -> Result<(), StoreError> {
        session(a)?;
        if saved.is_some() && self.privatized.load(Ordering::Relaxed) {
            return Ok(());
        }
        fence(c, a).await?;
        let q = format!(
            "SELECT v.* FROM saved_views v WHERE v.id=$4 AND {}",
            visibility()
        );
        let row: Option<Row> = sqlx::query_as(&q)
            .bind(&a.workspace_id)
            .bind(policy::privileged(a))
            .bind(&a.user_id)
            .bind(self.id)
            .fetch_optional(&mut *c)
            .await?;
        let Some(row) = row else {
            if self.input["action"] == "save"
                && self.input["expectedRevision"].is_null()
                && saved.is_none()
            {
                return Ok(());
            }
            return Err(StoreError::Forbidden);
        };
        if let Some(team) = row.team_id {
            policy::team(c, a, team).await?;
        }
        if self.input["action"] != "favorite" && !editable(a, &row) {
            return Err(StoreError::Forbidden);
        }
        Ok(())
    }
    async fn run(
        &self,
        c: &mut PgConnection,
        a: &Actor,
    ) -> Result<CommandResult<Saved>, StoreError> {
        let row: Option<Row> = sqlx::query_as("SELECT * FROM saved_views WHERE id=$1 FOR UPDATE")
            .bind(self.id)
            .fetch_optional(&mut *c)
            .await?;
        if row
            .as_ref()
            .is_some_and(|r| r.workspace_id != a.workspace_id || r.deleted_at.is_some())
        {
            return Err(StoreError::Forbidden);
        }
        let mut revision = row.as_ref().map_or(0, |r| r.revision);
        let action = text(self.input, "action");
        if action == "favorite" {
            if row.is_none() {
                return Err(StoreError::Forbidden);
            }
            if self.input["favorite"] == true {
                sqlx::query("INSERT INTO saved_view_favorites(workspace_id,user_id,view_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(&a.workspace_id).bind(&a.user_id).bind(self.id).execute(&mut *c).await?;
            } else {
                sqlx::query("DELETE FROM saved_view_favorites WHERE workspace_id=$1 AND user_id=$2 AND view_id=$3").bind(&a.workspace_id).bind(&a.user_id).bind(self.id).execute(&mut *c).await?;
            }
        } else {
            if if self.input["expectedRevision"].is_null() {
                row.is_some()
            } else {
                row.is_none() || self.input["expectedRevision"] != revision
            } {
                return Err(StoreError::Planning(
                    "This view changed in another session. Your draft is kept. Reload the latest view and review your changes.",
                ));
            }
            if row.as_ref().is_some_and(|r| !editable(a, r)) {
                return Err(StoreError::Forbidden);
            }
            revision = revision.checked_add(1).ok_or(StoreError::InvalidInput)?;
            if action == "delete" {
                sqlx::query("UPDATE saved_views SET deleted_at=now(),updated_at=now(),revision=$1 WHERE id=$2").bind(revision).bind(self.id).execute(&mut *c).await?;
                sqlx::query("DELETE FROM saved_view_favorites WHERE view_id=$1")
                    .bind(self.id)
                    .execute(&mut *c)
                    .await?;
            } else {
                let definition = &self.input["definition"];
                validate_references(c, a, definition, true).await?;
                self.privatized.store(
                    row.as_ref().is_some_and(|r| {
                        r.owner_id != a.user_id
                            && definition["visibility"] == "personal"
                            && policy::privileged(a)
                    }),
                    Ordering::Relaxed,
                );
                let team = definition
                    .get("teamId")
                    .map(|v| identity(v.as_str().unwrap()))
                    .transpose()?;
                if row.is_some() {
                    sqlx::query("UPDATE saved_views SET definition=$1,visibility=$2,team_id=$3,revision=$4,updated_at=now() WHERE id=$5").bind(definition).bind(text(definition,"visibility")).bind(team).bind(revision).bind(self.id).execute(&mut *c).await?;
                } else {
                    let count:i64=sqlx::query_scalar("SELECT count(*) FROM saved_views WHERE workspace_id=$1 AND deleted_at IS NULL").bind(&a.workspace_id).fetch_one(&mut *c).await?;
                    if count >= 500 {
                        return Err(StoreError::Planning(
                            "This workspace has reached its limit of 500 saved views.",
                        ));
                    }
                    sqlx::query("INSERT INTO saved_views(id,workspace_id,owner_id,definition,visibility,team_id,revision) VALUES($1,$2,$3,$4,$5,$6,$7)").bind(self.id).bind(&a.workspace_id).bind(&a.user_id).bind(definition).bind(text(definition,"visibility")).bind(team).bind(revision).execute(&mut *c).await?;
                }
            }
        }
        Ok(CommandResult {
            value: Saved {
                id: text(self.input, "id").into(),
                revision,
            },
            resource_type: "saved-view".into(),
            resource_id: text(self.input, "id").into(),
            events: vec![OutboxEvent {
                topic: format!("saved-view.{action}"),
                payload: json!({"viewId":self.input["id"],"version":1})
                    .as_object()
                    .unwrap()
                    .clone(),
            }],
        })
    }
}
pub async fn mutate(
    db: &Database,
    a: &Actor,
    key: &str,
    input: Value,
    options: ViewOptions,
) -> Result<Value, StoreError> {
    session(a)?;
    if !options.enabled {
        return Err(StoreError::Planning("Saved views are not enabled."));
    }
    let input = contract::mutation(input).map_err(|_| StoreError::InvalidInput)?;
    let id = identity(text(&input, "id"))?;
    let result = commands::execute(
        db,
        a,
        Command {
            key,
            operation: "saved-views.mutate@1",
            input: &input,
            status: 200,
        },
        &Mutation {
            input: &input,
            id,
            privatized: AtomicBool::new(false),
        },
    )
    .await?;
    Ok(json!({"replayed":result.replayed,"value":result.value}))
}
pub async fn query_projects(
    db: &Database,
    a: &Actor,
    definition: Value,
    options: ViewOptions,
) -> Result<Value, StoreError> {
    session(a)?;
    if !options.enabled {
        return Err(StoreError::Planning("Saved views are not enabled."));
    }
    let definition = contract::definition(definition).map_err(|_| StoreError::InvalidInput)?;
    if definition["kind"] != "projects" {
        return Err(StoreError::Planning("Choose a project view."));
    }
    let mut tx = db.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    lock_workspace(&mut tx, &a.workspace_id, false).await?;
    let a = current_actor(&mut tx, a).await?;
    validate_references(&mut tx, &a, &definition, false).await?;
    let q = format!(
        "SELECT p.id,p.name,p.revision,p.properties::text FROM projects p WHERE {} ORDER BY p.id LIMIT 501",
        policy::readable_project("p.id")
    );
    let rows: Vec<(Uuid, String, i32, String)> = sqlx::query_as(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(&a))
        .bind(&a.user_id)
        .fetch_all(&mut *tx)
        .await?;
    if rows.len() > 500 {
        return Err(StoreError::Planning(
            "This project view exceeds the supported limit of 500 projects.",
        ));
    }
    let visible: HashSet<String> = rows.iter().map(|r| r.0.to_string()).collect();
    let ids: Vec<String> = rows.iter().map(|r| r.0.to_string()).collect();
    let q = format!(
        "SELECT pt.project_id,pt.team_id FROM project_teams pt WHERE pt.workspace_id=$1 AND {}",
        policy::readable_team("pt.team_id")
    );
    let links: Vec<(Uuid, Uuid)> = sqlx::query_as(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(&a))
        .bind(&a.user_id)
        .fetch_all(&mut *tx)
        .await?;
    let mut catalog = vec![];
    for (id, name, revision, raw) in rows {
        let mut properties = forge_core::json::parse(&raw).map_err(|_| StoreError::InvalidInput)?;
        if !properties.is_object() {
            return Err(StoreError::InvalidInput);
        }
        properties["dependencyIds"] = json!(
            forge_core::projects::array(&properties, "dependencyIds")
                .iter()
                .filter(|id| id.as_str().is_some_and(|id| visible.contains(id)))
                .cloned()
                .collect::<Vec<_>>()
        );
        properties["id"] = json!(id);
        properties["name"] = json!(name);
        properties["revision"] = json!(revision);
        properties["teamIds"] = json!(
            links
                .iter()
                .filter(|r| r.0 == id)
                .map(|r| r.1)
                .collect::<Vec<_>>()
        );
        if properties["status"].is_null() {
            properties["status"] = json!("Backlog");
        }
        if properties["health"].is_null() {
            properties["health"] = json!("On track");
        }
        catalog.push(properties);
    }
    let projects =
        contract::visible_projects(&catalog, &definition).map_err(|_| StoreError::InvalidInput)?;
    tx.commit().await?;
    Ok(json!({"projects":projects,"authorizedProjectIds":ids}))
}
