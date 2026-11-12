//! Canonical shared projects. All relation writes use the workspace write fence.
use crate::{
    Database, StoreError,
    authority::current_actor,
    commands::{self, Command, CommandHandler, CommandResult, OutboxEvent},
    resource_policy as policy,
};
use async_trait::async_trait;
use chrono::{SecondsFormat, Utc};
use forge_core::{
    actor::{Actor, ApiScope, Authentication},
    projects as contract,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;
mod catalog;
mod content;
mod relocation;
pub(crate) use catalog::read as catalog_in;
pub use catalog::{read_catalog, save_catalog};
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}
fn array<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    contract::array(v, k)
}
fn id(v: &Value, k: &str) -> Result<Uuid, StoreError> {
    text(v, k).parse().map_err(|_| StoreError::InvalidInput)
}
fn invalid(s: &'static str) -> StoreError {
    StoreError::Planning(s)
}
fn parsed(r: Result<Value, forge_core::planning::PlanningError>) -> Result<Value, StoreError> {
    r.map_err(|e| invalid(e.0))
}
fn event(topic: &str, payload: Value) -> OutboxEvent {
    OutboxEvent {
        topic: topic.into(),
        payload: payload.as_object().unwrap().clone(),
    }
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}
async fn fence(c: &mut PgConnection, a: &Actor) -> Result<(), StoreError> {
    sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
        .bind(&a.workspace_id)
        .fetch_optional(c)
        .await?
        .ok_or(StoreError::Forbidden)?;
    Ok(())
}
#[derive(FromRow)]
struct Row {
    id: Uuid,
    name: String,
    revision: i32,
    properties: Value,
}
async fn visible(c: &mut PgConnection, a: &Actor, id: Uuid) -> Result<(), StoreError> {
    let q = format!(
        "SELECT p.id FROM projects p WHERE p.id=$4 AND {}",
        policy::readable_project(a, "p.id")
    );
    sqlx::query(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .bind(id)
        .fetch_optional(c)
        .await?
        .ok_or(StoreError::Forbidden)?;
    Ok(())
}
async fn links(c: &mut PgConnection, id: Uuid) -> Result<Vec<Uuid>, StoreError> {
    Ok(
        sqlx::query_scalar(
            "SELECT team_id FROM project_teams WHERE project_id=$1 ORDER BY team_id",
        )
        .bind(id)
        .fetch_all(c)
        .await?,
    )
}
async fn visible_teams(c: &mut PgConnection, a: &Actor, id: Uuid) -> Result<Vec<Uuid>, StoreError> {
    let q = format!(
        "SELECT p.team_id FROM project_teams p WHERE p.project_id=$4 AND {}",
        policy::readable_team(a, "p.team_id")
    );
    Ok(sqlx::query_scalar(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .bind(id)
        .fetch_all(c)
        .await?)
}
async fn require_team(c: &mut PgConnection, a: &Actor, team: Uuid) -> Result<(), StoreError> {
    sqlx::query(
        "SELECT id FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3 FOR SHARE",
    )
    .bind(&a.workspace_id)
    .bind(team)
    .bind(&a.user_id)
    .fetch_optional(&mut *c)
    .await?;
    policy::team(c, a, team).await
}
pub(crate) async fn lock_project(
    c: &mut PgConnection,
    a: &Actor,
    id: Uuid,
) -> Result<(), StoreError> {
    sqlx::query("SELECT id FROM projects WHERE workspace_id=$1 AND id=$2 FOR SHARE")
        .bind(&a.workspace_id)
        .bind(id)
        .fetch_optional(&mut *c)
        .await?
        .ok_or(StoreError::Forbidden)?;
    for team in links(c, id).await? {
        sqlx::query("SELECT id FROM team_members WHERE team_id=$1 AND user_id=$2 FOR SHARE")
            .bind(team)
            .bind(&a.user_id)
            .fetch_optional(&mut *c)
            .await?;
        sqlx::query("SELECT id FROM teams WHERE id=$1 FOR SHARE")
            .bind(team)
            .fetch_optional(&mut *c)
            .await?;
    }
    visible(c, a, id).await
}
async fn dependencies(
    c: &mut PgConnection,
    a: &Actor,
    id: Uuid,
    desired: &[Value],
    previous: &[Value],
) -> Result<Value, StoreError> {
    let q = format!(
        "SELECT p.id::text FROM projects p WHERE p.workspace_id=$1 AND {}",
        policy::readable_project(a, "p.id")
    );
    let visible: HashSet<String> = sqlx::query_scalar::<_, String>(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .fetch_all(&mut *c)
        .await?
        .into_iter()
        .collect();
    let mut checked = HashSet::new();
    for target in desired.iter().chain(
        previous
            .iter()
            .filter(|p| visible.contains(p.as_str().unwrap_or_default())),
    ) {
        let target = target.as_str().unwrap_or_default();
        if !visible.contains(target) {
            return Err(invalid("Choose an accessible dependency project."));
        }
        if checked.insert(target) {
            lock_project(c, a, target.parse().map_err(|_| StoreError::InvalidInput)?).await?;
        }
    }
    let mut effective = Vec::new();
    for v in previous
        .iter()
        .filter(|p| !visible.contains(p.as_str().unwrap_or_default()))
        .chain(desired)
    {
        if !effective.contains(v) {
            effective.push(v.clone());
        }
    }
    let rows: Vec<(Uuid, Value)> =
        sqlx::query_as("SELECT id,properties FROM projects WHERE workspace_id=$1")
            .bind(&a.workspace_id)
            .fetch_all(c)
            .await?;
    let mut graph: HashMap<String, Vec<String>> = rows
        .iter()
        .map(|(id, p)| {
            (
                id.to_string(),
                array(p, "dependencyIds")
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect(),
            )
        })
        .collect();
    graph.insert(
        id.to_string(),
        effective
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect(),
    );
    // Iterative DFS avoids a stack limit for imported dependency graphs.
    let mut colors = HashMap::new();
    let mut pending = vec![(id.to_string(), false)];
    while let Some((node, exit)) = pending.pop() {
        if exit {
            colors.insert(node, 2);
            continue;
        }
        match colors.get(&node) {
            Some(1) => return Err(invalid("These project dependencies would create a cycle.")),
            Some(2) => continue,
            _ => {}
        }
        colors.insert(node.clone(), 1);
        pending.push((node.clone(), true));
        for next in graph.get(&node).into_iter().flatten().rev() {
            pending.push((next.clone(), false));
        }
    }
    Ok(json!(effective))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    #[serde(deserialize_with = "one")]
    revision: u8,
}
fn one<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u8, D::Error> {
    let n = u8::deserialize(d)?;
    if n == 1 {
        Ok(n)
    } else {
        Err(serde::de::Error::custom("project receipt version"))
    }
}
struct Save<'a> {
    changes: &'a Value,
}
pub(crate) async fn apply_changes(
    c: &mut PgConnection,
    a: &Actor,
    changes: Value,
) -> Result<Vec<OutboxEvent>, StoreError> {
    let changes = parsed(contract::changes(changes))?;
    let handler = Save { changes: &changes };
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
        replay: Option<&Saved>,
    ) -> Result<(), StoreError> {
        policy::scope(a, ApiScope::ProjectsRead)?;
        policy::scope(a, ApiScope::ProjectsWrite)?;
        fence(c, a).await?;
        for change in self.changes.as_array().unwrap() {
            if !change["expectedRevision"].is_null() || replay.is_some() {
                lock_project(c, a, id(change, "id")?).await?;
            }
            let relocation = &change["relocation"];
            let target = relocation.get("targetId").or_else(|| {
                if replay.is_some() {
                    relocation.get("convertId")
                } else {
                    None
                }
            });
            if let Some(target) = target {
                lock_project(
                    c,
                    a,
                    target
                        .as_str()
                        .unwrap()
                        .parse()
                        .map_err(|_| StoreError::InvalidInput)?,
                )
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
        let mut events = vec![];
        for change in self.changes.as_array().unwrap() {
            let project = id(change, "id")?;
            let old:Option<Row>=sqlx::query_as("SELECT id,name,revision,properties FROM projects WHERE workspace_id=$1 AND id=$2 FOR UPDATE").bind(&a.workspace_id).bind(project).fetch_optional(&mut *c).await?;
            if if change["expectedRevision"].is_null() {
                old.is_some()
            } else {
                old.as_ref()
                    .is_none_or(|r| change["expectedRevision"] != r.revision)
            } {
                return Err(invalid(
                    "This project changed in another session. Your draft is preserved. Load the latest shared version and review your changes.",
                ));
            }
            let now = now();
            let changes = &change["changes"];
            if change.get("relocation").is_some()
                && (old.is_none() || !changes.as_object().unwrap().is_empty())
            {
                return Err(invalid("Relocate a saved milestone in a separate command."));
            }
            let relocated =
                if let (Some(relocation), Some(old)) = (change.get("relocation"), old.as_ref()) {
                    Some(relocation::relocate(c, a, old, relocation, &now).await?)
                } else {
                    None
                };
            let previous = old
                .as_ref()
                .map(|r| r.properties.clone())
                .unwrap_or(json!({}));
            let mut input = json!({"status":"Backlog","teamIds":[]});
            input
                .as_object_mut()
                .unwrap()
                .extend(previous.as_object().unwrap().clone());
            input
                .as_object_mut()
                .unwrap()
                .extend(changes.as_object().unwrap().clone());
            if changes.get("name").is_none()
                && let Some(old) = &old
            {
                input["name"] = json!(old.name);
            }
            let mut core = parsed(contract::fields(input, false, false))?;
            if changes.get("dependencyIds").is_some() {
                core["dependencyIds"] = dependencies(
                    c,
                    a,
                    project,
                    array(changes, "dependencyIds"),
                    array(&previous, "dependencyIds"),
                )
                .await?;
            }
            if relocated.is_none()
                && changes.get("milestones").is_some()
                && array(&previous, "milestones").iter().any(|m| {
                    !array(&core, "milestones")
                        .iter()
                        .any(|n| m["id"] == n["id"])
                })
            {
                return Err(invalid(
                    "Use the milestone deletion command to update all issue assignments together.",
                ));
            }
            let mut milestone_event = None;
            if let Some(r) = relocated {
                core["milestones"] = json!(r.milestones);
                events.extend(r.events);
                milestone_event = Some(r.event);
            }
            content::milestones(&previous, &mut core, &now)?;
            let catalog = catalog::read(c, a).await?;
            if changes["statusId"].as_str().is_some_and(|s| !s.is_empty()) {
                let status = array(&catalog["statuses"], "statuses")
                    .iter()
                    .find(|s| s["id"] == core["statusId"])
                    .ok_or_else(|| invalid("Choose an active project status."))?;
                core["status"] = json!(contract::status_value(text(status, "group")));
            } else if changes.get("status").is_some() {
                core["statusId"] = json!("");
            }
            for label in array(changes, "labelIds") {
                if !array(&previous, "labelIds").contains(label)
                    && !array(&catalog["labels"], "labels")
                        .iter()
                        .any(|l| l["id"] == *label && l["archived"] != true)
                    && !array(&catalog["labels"], "groups")
                        .iter()
                        .any(|l| l["id"] == *label)
                {
                    return Err(invalid("Choose an active project label."));
                }
            }
            for key in ["updates", "comments"] {
                if changes.get(key).is_some() {
                    core[key] = json!(content::reconcile(
                        a,
                        array(&previous, key),
                        array(&core, key),
                        &now
                    )?);
                }
            }
            if let (Some(start), Some(end)) = (
                contract::target_day(text(&core, "startDate")),
                contract::target_day(text(&core, "targetDate")),
            ) && start > end
            {
                return Err(invalid(
                    "The target date must be on or after the start date.",
                ));
            }
            for member in std::iter::once(&changes["leadId"]).chain(array(changes, "memberIds")) {
                if let Some(member) = member.as_str().filter(|s| !s.is_empty()) {
                    sqlx::query(
                        "SELECT id FROM member WHERE organization_id=$1 AND user_id=$2 FOR SHARE",
                    )
                    .bind(&a.workspace_id)
                    .bind(member)
                    .fetch_optional(&mut *c)
                    .await?
                    .ok_or_else(|| invalid("Choose a current workspace member for the project."))?;
                }
            }
            let links = links(c, project).await?;
            let visible = visible_teams(c, a, project).await?;
            let desired = if let Some(ids) = changes["teamIds"].as_array() {
                let mut ids: Vec<Uuid> = ids
                    .iter()
                    .map(|v| v.as_str().unwrap().parse().unwrap())
                    .collect();
                ids.sort();
                ids.dedup();
                ids
            } else {
                visible.clone()
            };
            for team in &desired {
                if !visible.contains(team) {
                    require_team(c, a, *team).await?;
                }
            }
            let removed: Vec<_> = visible
                .iter()
                .copied()
                .filter(|t| !desired.contains(t))
                .collect();
            for team in &removed {
                require_team(c, a, *team).await?;
            }
            if !removed.is_empty()
                && sqlx::query(
                    "SELECT id FROM issues WHERE project_id=$1 AND team_id=ANY($2) LIMIT 1",
                )
                .bind(project)
                .bind(&removed)
                .fetch_optional(&mut *c)
                .await?
                .is_some()
            {
                return Err(invalid(
                    "Move this team's issues out of the project before removing the team.",
                ));
            }
            let effective: Vec<_> = links
                .iter()
                .filter(|t| !visible.contains(t))
                .chain(desired.iter())
                .copied()
                .collect();
            if changes.get("teamIds").is_some()
                && !effective.is_empty()
                && sqlx::query(
                    "SELECT id FROM issues WHERE project_id=$1 AND NOT(team_id=ANY($2)) LIMIT 1",
                )
                .bind(project)
                .bind(&effective)
                .fetch_optional(&mut *c)
                .await?
                .is_some()
            {
                return Err(StoreError::Forbidden);
            }
            let mut properties = previous.clone();
            properties
                .as_object_mut()
                .unwrap()
                .extend(core.as_object().unwrap().clone());
            properties.as_object_mut().unwrap().remove("teamIds");
            properties["health"] = core["updates"][0]
                .get("health")
                .cloned()
                .unwrap_or(json!("Update missing"));
            let mut history = array(&previous, "milestoneEvents").to_vec();
            if let Some(event) = milestone_event {
                history.push(event);
            } else {
                history.extend(content::milestone_events(
                    a,
                    array(&previous, "milestones"),
                    array(&core, "milestones"),
                    &now,
                ));
            }
            if history.len() > 1000 {
                history.drain(..history.len() - 1000);
            }
            properties["milestoneEvents"] = json!(history);
            properties["creatorId"] = previous
                .get("creatorId")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(json!(a.user_id));
            properties["createdAt"] = previous
                .get("createdAt")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(json!(now));
            properties["updatedAt"] = json!(now);
            content::bind_files(c, a, project, &previous, &mut properties).await?;
            if old.is_some() {
                sqlx::query("UPDATE projects SET name=$1,properties=$2 WHERE id=$3")
                    .bind(text(&core, "name"))
                    .bind(properties)
                    .bind(project)
                    .execute(&mut *c)
                    .await?;
            } else {
                sqlx::query(
                    "INSERT INTO projects(id,workspace_id,name,properties) VALUES($1,$2,$3,$4)",
                )
                .bind(project)
                .bind(&a.workspace_id)
                .bind(text(&core, "name"))
                .bind(properties)
                .execute(&mut *c)
                .await?;
            }
            if !removed.is_empty() {
                sqlx::query("DELETE FROM project_teams WHERE project_id=$1 AND team_id=ANY($2)")
                    .bind(project)
                    .bind(removed)
                    .execute(&mut *c)
                    .await?;
            }
            for team in desired.iter().filter(|t| !links.contains(t)) {
                sqlx::query(
                    "INSERT INTO project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3)",
                )
                .bind(&a.workspace_id)
                .bind(project)
                .bind(team)
                .execute(&mut *c)
                .await?;
            }
        }
        for change in self.changes.as_array().unwrap() {
            events.push(event(if change["expectedRevision"].is_null(){"project.created"}else{"project.updated"},json!({"projectId":change["id"],"version":1,"fields":change["changes"].as_object().unwrap().keys().collect::<Vec<_>>(),"actorUserId":a.user_id})));
        }
        Ok(CommandResult {
            value: Saved { revision: 1 },
            resource_type: "project".into(),
            resource_id: text(&self.changes[0], "id").into(),
            events,
        })
    }
}
pub async fn save(
    database: &Database,
    actor: &Actor,
    command_key: &str,
    changes: Value,
) -> Result<Value, StoreError> {
    let changes = contract::changes(changes).map_err(|_| StoreError::InvalidInput)?;
    let result = commands::execute(
        database,
        actor,
        Command {
            key: command_key,
            operation: "projects.save@1",
            input: &changes,
            status: 200,
        },
        &Save { changes: &changes },
    )
    .await?;
    Ok(json!({"value":result.value,"replayed":result.replayed}))
}
pub async fn read(database: &Database, actor: &Actor) -> Result<Value, StoreError> {
    let mut tx = database.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let actor = current_actor(&mut tx, actor).await?;
    policy::scope(&actor, ApiScope::ProjectsRead)?;
    let result = snapshot(&mut tx, &actor, None).await?;
    let catalog = catalog::projected(&mut tx, &actor).await?;
    tx.commit().await?;
    let session = if let Authentication::Session { session_id } = &actor.authentication {
        session_id.as_str()
    } else {
        ""
    };
    Ok(
        json!({"workspaceId":actor.workspace_id,"userId":actor.user_id,"sessionId":session,"projects":result,"catalog":catalog}),
    )
}

pub(crate) async fn snapshot(
    c: &mut PgConnection,
    actor: &Actor,
    selected: Option<&[Uuid]>,
) -> Result<Vec<Value>, StoreError> {
    let q = format!(
        "SELECT p.id,p.name,p.revision,p.properties FROM projects p WHERE p.workspace_id=$1 AND {} ORDER BY p.id",
        policy::readable_project(actor, "p.id")
    );
    let rows: Vec<Row> = sqlx::query_as(&q)
        .bind(&actor.workspace_id)
        .bind(policy::privileged(actor))
        .bind(&actor.user_id)
        .fetch_all(&mut *c)
        .await?;
    let visible: HashSet<String> = rows.iter().map(|r| r.id.to_string()).collect();
    let link_query = format!(
        "SELECT p.project_id,p.team_id FROM project_teams p WHERE p.workspace_id=$1 AND {} AND ($4::uuid[] IS NULL OR p.project_id=ANY($4))",
        policy::readable_team(actor, "p.team_id")
    );
    let team_links: Vec<(Uuid, Uuid)> = sqlx::query_as(&link_query)
        .bind(&actor.workspace_id)
        .bind(policy::privileged(actor))
        .bind(&actor.user_id)
        .bind(selected)
        .fetch_all(&mut *c)
        .await?;
    let mut result = vec![];
    for row in rows
        .into_iter()
        .filter(|r| selected.is_none_or(|ids| ids.contains(&r.id)))
    {
        let mut p = row.properties;
        p["id"] = json!(row.id);
        p["name"] = json!(row.name);
        p["revision"] = json!(row.revision);
        p["teamIds"] = json!(
            team_links
                .iter()
                .filter(|(id, _)| *id == row.id)
                .map(|(_, team)| team)
                .collect::<Vec<_>>()
        );
        p["dependencyIds"] = json!(
            array(&p, "dependencyIds")
                .iter()
                .filter(|v| v.as_str().is_some_and(|s| visible.contains(s)))
                .collect::<Vec<_>>()
        );
        if p.get("status").is_none() {
            p["status"] = json!("Backlog");
        }
        if p.get("health").is_none() {
            p["health"] = json!("Update missing");
        }
        result.push(parsed(forge_core::planning::project(p))?);
    }
    Ok(result)
}
