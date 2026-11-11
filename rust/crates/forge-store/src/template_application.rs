//! Template application composes existing commands in one durable transaction.
//! A committed receipt keeps its identity even if its template later changes.
use crate::{
    Database, StoreError,
    authority::current_actor,
    commands::{self, Command, CommandHandler, CommandResult, OutboxEvent},
    initiatives::{self, InitiativeOptions},
    issues::{self, IssueOptions},
    projects, resource_policy as policy, templates,
};
use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat, Utc};
use forge_core::{
    actor::{Actor, ApiScope, Authentication},
    issues::CreateIssue,
    template_application as contract, templates as definitions,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection};
use std::collections::{BTreeSet, HashSet};
use uuid::Uuid;

#[derive(Clone, Copy, Default)]
pub struct Options {
    pub enabled: bool,
    pub issues: IssueOptions,
    pub initiatives: InitiativeOptions,
}
impl Options {
    pub fn from_env() -> Self {
        Self {
            enabled: std::env::var("FORGE_FEATURE_TEMPLATES").as_deref() == Ok("true"),
            issues: IssueOptions::from_env(),
            initiatives: InitiativeOptions::from_env(),
        }
    }
}
fn invalid(message: &str) -> StoreError {
    StoreError::TemplateApplication(message.into())
}
fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_default()
}
fn array<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    forge_core::projects::array(v, key)
}
fn id(v: &Value) -> Result<Uuid, StoreError> {
    v.as_str()
        .and_then(|s| s.parse().ok())
        .ok_or(StoreError::InvalidInput)
}
fn gate(a: &Actor, options: Options) -> Result<(), StoreError> {
    if options.enabled
        && matches!(a.authentication, Authentication::Session { .. })
        && a.scopes.is_none()
    {
        Ok(())
    } else {
        Err(StoreError::Forbidden)
    }
}
async fn fence(c: &mut PgConnection, a: &Actor) -> Result<(), StoreError> {
    sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
        .bind(&a.workspace_id)
        .fetch_optional(&mut *c)
        .await?
        .ok_or(StoreError::Forbidden)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,4040))")
        .bind(&a.workspace_id)
        .execute(c)
        .await?;
    Ok(())
}
#[derive(FromRow)]
struct Stored {
    team_id: Option<Uuid>,
    payload: String,
    updated_at: DateTime<Utc>,
}
struct Template {
    team: Option<Uuid>,
    payload: Value,
    updated_at: String,
}
async fn load(
    c: &mut PgConnection,
    a: &Actor,
    template: Uuid,
) -> Result<Option<Template>, StoreError> {
    let row: Option<Stored> = sqlx::query_as("SELECT team_id,payload::text payload,updated_at FROM team_templates WHERE workspace_id=$1 AND id=$2 FOR SHARE").bind(&a.workspace_id).bind(template).fetch_optional(c).await?;
    row.map(|r| {
        Ok(Template {
            team: r.team_id,
            payload: forge_core::json::parse(&r.payload).map_err(|_| StoreError::InvalidInput)?,
            updated_at: r.updated_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        })
    })
    .transpose()
}
async fn access(c: &mut PgConnection, a: &Actor, row: &Template) -> Result<(), StoreError> {
    let mut ids = BTreeSet::new();
    if let Some(team) = row.team {
        ids.insert(team);
    }
    if let Some(visibility) = row.payload["visibility"].as_str().filter(|s| !s.is_empty()) {
        ids.insert(visibility.parse().map_err(|_| StoreError::Forbidden)?);
    }
    for team in ids {
        sqlx::query("SELECT id FROM team_members WHERE team_id=$1 AND user_id=$2 FOR SHARE")
            .bind(team)
            .bind(&a.user_id)
            .fetch_optional(&mut *c)
            .await?;
        policy::team(c, a, team).await?;
    }
    Ok(())
}
pub async fn directory(
    db: &Database,
    a: &Actor,
    input: Value,
    options: Options,
) -> Result<Value, StoreError> {
    let input = contract::query(input).map_err(|_| StoreError::InvalidInput)?;
    if !options.enabled {
        return Ok(json!({"enabled":false,"templates":[],"teams":[],"defaultId":null}));
    }
    let mut tx = db.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let a = current_actor(&mut tx, a).await?;
    gate(&a, options)?;
    let workspace = templates::read_in(&mut tx, &a, json!({}), false).await?;
    let team = if let Some(slug) = input.get("slug") {
        Some(templates::read_in(&mut tx, &a, json!({"slug":slug}), false).await?)
    } else {
        None
    };
    let mut combined = array(&workspace, "templates").to_vec();
    if let Some(team) = &team {
        combined.extend_from_slice(array(team, "templates"));
    }
    combined.retain(|t| {
        ["issue", "project"].contains(&text(&t["payload"], "kind"))
            && input
                .get("kind")
                .is_none_or(|kind| *kind == t["payload"]["kind"])
    });
    for row in &mut combined {
        row["revision"] = json!(contract::revision(&row["payload"], text(row, "updatedAt")));
    }
    let default = if let Some(team) = team {
        let selected = array(&team, "teams")
            .iter()
            .find(|t| t["slug"] == input["slug"])
            .ok_or(StoreError::Forbidden)?;
        let member = sqlx::query("SELECT id FROM team_members WHERE team_id=$1 AND user_id=$2")
            .bind(id(&selected["id"])?)
            .bind(&a.user_id)
            .fetch_optional(&mut *tx)
            .await?
            .is_some();
        team["defaults"][if member { "members" } else { "nonMembers" }].clone()
    } else {
        Value::Null
    };
    let default = if combined.iter().any(|t| t["id"] == default) {
        default
    } else {
        Value::Null
    };
    tx.commit().await?;
    Ok(json!({"enabled":true,"templates":combined,"teams":workspace["teams"],"defaultId":default}))
}
pub async fn references(db: &Database, a: &Actor, options: Options) -> Result<Value, StoreError> {
    let mut tx = db.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    let a = current_actor(&mut tx, a).await?;
    gate(&a, options)?;
    let q = format!(
        "SELECT jsonb_build_object('id',p.id,'name',p.name) FROM projects p WHERE p.workspace_id=$1 AND {} ORDER BY p.id",
        policy::readable_project("p.id")
    );
    let projects: Vec<Value> = sqlx::query_scalar(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(&a))
        .bind(&a.user_id)
        .fetch_all(&mut *tx)
        .await?;
    let initiatives: Vec<Value> = if initiatives::settings(&mut tx, &a, options.initiatives).await?
        ["settings"]["enabled"]
        == true
    {
        sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name',name) FROM initiatives WHERE workspace_id=$1 ORDER BY id").bind(&a.workspace_id).fetch_all(&mut *tx).await?
    } else {
        vec![]
    };
    let catalog = projects::catalog_in(&mut tx, &a).await?;
    tx.commit().await?;
    Ok(
        json!({"projects":projects,"initiatives":initiatives,"catalog":{"statuses":catalog["statuses"],"labels":catalog["labels"]}}),
    )
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Issue,
    Project,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    kind: Kind,
    id: Uuid,
    issue_ids: Vec<Uuid>,
    project_ids: Vec<Uuid>,
    initiative_ids: Vec<Uuid>,
}
struct Apply<'a> {
    input: &'a Value,
    options: Options,
}
#[async_trait]
impl CommandHandler for Apply<'_> {
    type Output = Receipt;
    async fn before_actor(&self, c: &mut PgConnection, a: &Actor) -> Result<(), StoreError> {
        fence(c, a).await
    }
    async fn authorize(
        &self,
        c: &mut PgConnection,
        a: &Actor,
        value: Option<&Receipt>,
    ) -> Result<(), StoreError> {
        gate(a, self.options)?;
        let Some(value) = value else { return Ok(()) };
        let row = load(c, a, id(&self.input["templateId"])?)
            .await?
            .ok_or(StoreError::Forbidden)?;
        access(c, a, &row).await?;
        if !value.initiative_ids.is_empty() {
            if initiatives::settings(c, a, self.options.initiatives).await?["settings"]["enabled"]
                != true
            {
                return Err(StoreError::Forbidden);
            }
            let found: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM initiatives WHERE workspace_id=$1 AND id=ANY($2)",
            )
            .bind(&a.workspace_id)
            .bind(&value.initiative_ids)
            .fetch_one(&mut *c)
            .await?;
            if found != value.initiative_ids.len() as i64 {
                return Err(StoreError::Forbidden);
            }
        }
        if !value.project_ids.is_empty() {
            policy::scope(a, ApiScope::ProjectsRead)?;
            policy::scope(a, ApiScope::ProjectsWrite)?;
            for project in &value.project_ids {
                projects::lock_project(c, a, *project).await?;
            }
        }
        if !value.issue_ids.is_empty() {
            policy::scope(a, ApiScope::IssuesRead)?;
            policy::scope(a, ApiScope::IssuesWrite)?;
            let mut teams = BTreeSet::new();
            for issue in &value.issue_ids {
                teams.insert(policy::issue(c, a, *issue, false).await?.team_id);
            }
            for team in teams {
                issues::require_issue_team(c, a, team).await?;
            }
        }
        Ok(())
    }
    async fn run(
        &self,
        c: &mut PgConnection,
        a: &Actor,
    ) -> Result<CommandResult<Receipt>, StoreError> {
        // Only errors from the SQL effect are repairable. Preparation, replay,
        // receipt publication and COMMIT failures keep the original retry identity.
        self.create(c,a).await.map_err(|error|match error {
            StoreError::Forbidden=>invalid("A referenced team, project, or initiative is no longer accessible or enabled. Repair the template references and try again."),
            StoreError::InvalidInput=>invalid("Check the template title and content, then try again."),
            StoreError::Planning(s)|StoreError::IssueValidation(s)|StoreError::IssueRejected(s)=>invalid(s),
            other=>other,
        })
    }
}
struct IssueDraft<'a> {
    title: &'a Value,
    content: Value,
    properties: &'a Value,
    parent: Option<Uuid>,
    project: Option<Uuid>,
}
struct Creation<'a> {
    input: &'a Value,
    template: &'a Value,
    team: Option<Uuid>,
    options: Options,
}
impl Creation<'_> {
    async fn issue(
        &self,
        c: &mut PgConnection,
        a: &Actor,
        draft: IssueDraft<'_>,
    ) -> Result<CommandResult<Uuid>, StoreError> {
        let p = draft.properties;
        if array(p, "teamIds").len() > 1 {
            return Err(invalid("Choose one team for each issue in this template."));
        }
        let team = array(p, "teamIds")
            .first()
            .or_else(|| self.input.get("teamId"))
            .or_else(|| array(&self.template["properties"], "teamIds").first())
            .map(id)
            .transpose()?
            .or(self.team)
            .ok_or_else(|| invalid("Choose a team before creating this issue."))?;
        if !array(p, "initiatives").is_empty()
            || !array(p, "dependencies").is_empty()
            || !text(p, "lead").is_empty()
            || !array(p, "members").is_empty()
        {
            return Err(invalid(
                "Issue properties contain project-only settings. Move those settings to the project template.",
            ));
        }
        let statuses:Vec<String>=sqlx::query_scalar("SELECT id FROM issue_statuses WHERE workspace_id=$1 AND team_id=$2 AND (id=$3 OR name=$3) FOR SHARE").bind(&a.workspace_id).bind(team).bind(text(p,"status")).fetch_all(&mut *c).await?;
        if statuses.len() != 1 {
            return Err(invalid(
                "An issue status in this template is unavailable. Choose a current status in the template and try again.",
            ));
        }
        let mut labels = vec![];
        for label in array(p, "labels") {
            let rows:Vec<String>=sqlx::query_scalar("SELECT name FROM resource_labels WHERE workspace_id=$1 AND (team_id IS NULL OR team_id=$2) AND (id::text=$3 OR name=$3) AND COALESCE(definition->'archived','false'::jsonb)<>'true'::jsonb FOR SHARE").bind(&a.workspace_id).bind(team).bind(label.as_str().unwrap()).fetch_all(&mut *c).await?;
            if rows.len() != 1 {
                return Err(invalid(
                    "An issue label is unavailable or ambiguous. Choose an active label in the template.",
                ));
            }
            labels.push(rows[0].clone());
        }
        let mut value = forge_core::issues::blank(&statuses[0]);
        for (key, v) in [
            ("title", draft.title.clone()),
            ("description", contract::document_text(&draft.content)),
            ("descriptionDoc", draft.content),
            ("priority", p["priority"].clone()),
            ("assignee", json!(text(p, "assignee"))),
            ("labels", json!(labels.join(","))),
            (
                "project",
                draft
                    .project
                    .map_or_else(|| json!(text(p, "project")), |id| json!(id)),
            ),
            (
                "parentId",
                draft.parent.map_or_else(|| json!(""), |id| json!(id)),
            ),
            (
                "triage",
                json!(draft.parent.is_none() && self.input["triage"] == true),
            ),
        ] {
            value[key] = v;
        }
        if let Some(estimate) = p.get("estimate") {
            value["estimate"] = estimate.clone();
        }
        let assignee = if text(p, "assignee").is_empty() {
            Value::Null
        } else {
            p["assignee"].clone()
        };
        let input=CreateIssue::parse(json!({"commandKey":self.input["commandKey"],"teamId":team,"assigneeId":assignee,"draft":value})).map_err(|_|StoreError::InvalidInput)?;
        issues::create_in(c, a, &input, self.options.issues).await
    }
}
#[derive(FromRow)]
struct Project {
    id: Uuid,
    revision: i32,
    properties: Value,
}
async fn project_matches(
    c: &mut PgConnection,
    a: &Actor,
    reference: &str,
) -> Result<Vec<Project>, StoreError> {
    let q = format!(
        "SELECT p.id,p.revision,p.properties FROM projects p WHERE p.workspace_id=$1 AND {} AND (p.id::text=$4 OR p.name=$4)",
        policy::readable_project("p.id")
    );
    Ok(sqlx::query_as(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .bind(reference)
        .fetch_all(c)
        .await?)
}
fn unique<T: Eq + std::hash::Hash + Copy>(ids: &mut Vec<T>) {
    let mut seen = HashSet::new();
    ids.retain(|id| seen.insert(*id));
}
impl Apply<'_> {
    async fn create(
        &self,
        c: &mut PgConnection,
        a: &Actor,
    ) -> Result<CommandResult<Receipt>, StoreError> {
        let row = load(c, a, id(&self.input["templateId"])?)
            .await?
            .ok_or_else(|| {
                invalid("This template was removed. Reload templates and choose another template.")
            })?;
        if let Err(error) = access(c, a, &row).await {
            return Err(match error {
                StoreError::Forbidden => invalid(
                    "This template is no longer available to you. Reload templates and choose an accessible template.",
                ),
                other => other,
            });
        }
        if self.input["revision"] != contract::revision(&row.payload, &row.updated_at) {
            return Err(invalid(
                "This template changed. Reload templates and review the latest version before creating.",
            ));
        }
        let template=definitions::payload(row.payload).map_err(|_|invalid("This template contains invalid content. Ask a template administrator to repair it."))?;
        if template["kind"] == "document" {
            return Err(invalid("Choose an issue or project template."));
        }
        let creator = Creation {
            input: self.input,
            template: &template,
            team: row.team,
            options: self.options,
        };
        let mut events: Vec<OutboxEvent> = vec![];
        let mut issue_ids = vec![];
        let mut project_ids = vec![];
        let mut initiative_ids = vec![];
        let title = self.input.get("title").unwrap_or(&template["title"]);
        let (kind, id) = if template["kind"] == "issue" {
            if !array(&template, "issues").is_empty() || !array(&template, "milestones").is_empty()
            {
                return Err(invalid(
                    "Move project issues and milestones to a project template.",
                ));
            }
            let content = contract::form_content(&template, &self.input["answers"])
                .map_err(StoreError::TemplateApplication)?;
            let result = creator
                .issue(
                    c,
                    a,
                    IssueDraft {
                        title,
                        content,
                        properties: &template["properties"],
                        parent: None,
                        project: None,
                    },
                )
                .await?;
            let id = result.value;
            issue_ids.push(id);
            events.extend(result.events);
            for child in array(&template, "subIssues") {
                let result = creator
                    .issue(
                        c,
                        a,
                        IssueDraft {
                            title: &child["title"],
                            content: child["content"].clone(),
                            properties: &child["properties"],
                            parent: Some(id),
                            project: None,
                        },
                    )
                    .await?;
                issue_ids.push(result.value);
                events.extend(result.events);
            }
            (Kind::Issue, id)
        } else {
            if self.input["triage"] == true {
                return Err(invalid("Choose an issue template for triage."));
            }
            if !self.input["answers"].as_object().unwrap().is_empty()
                || !array(&template, "fields").is_empty()
                || !array(&template, "subIssues").is_empty()
            {
                return Err(invalid(
                    "Move form fields and sub-issues to an issue template.",
                ));
            }
            let p = &template["properties"];
            if ["project", "assignee", "estimate"]
                .iter()
                .any(|key| !text(p, key).is_empty())
            {
                return Err(invalid("Move issue-only properties to an issue template."));
            }
            let catalog = projects::catalog_in(c, a).await?;
            let statuses: Vec<_> = array(&catalog["statuses"], "statuses")
                .iter()
                .filter(|s| s["id"] == p["status"] || s["name"] == p["status"])
                .collect();
            if statuses.len() != 1 {
                return Err(invalid(
                    "The project status is unavailable. Choose a current project status in the template.",
                ));
            }
            let mut labels = vec![];
            for label in array(p, "labels") {
                let found: Vec<_> = array(&catalog["labels"], "labels")
                    .iter()
                    .filter(|l| l["archived"] != true && (l["id"] == *label || l["name"] == *label))
                    .collect();
                if found.len() != 1 {
                    return Err(invalid(
                        "A project label is unavailable. Choose an active label in the template.",
                    ));
                }
                labels.push(found[0]["id"].clone());
            }
            let id = Uuid::new_v4();
            let mut dependencies = vec![];
            let mut blocking = vec![];
            for dependency in array(p, "dependencies") {
                let mut found = project_matches(c, a, text(dependency, "name")).await?;
                if found.len() != 1 {
                    return Err(invalid(
                        "A dependency project is unavailable or ambiguous. Choose an accessible project in the template.",
                    ));
                }
                let project = found.pop().unwrap();
                if dependency["direction"] == "blockedBy" {
                    dependencies.push(project.id)
                } else {
                    blocking.push(project)
                }
            }
            let teams = if !array(p, "teamIds").is_empty() {
                p["teamIds"].clone()
            } else if let Some(team) = self.input.get("teamId") {
                json!([team])
            } else {
                json!(row.team.into_iter().collect::<Vec<_>>())
            };
            let milestones:Vec<_>=array(&template,"milestones").iter().map(|m|json!({"id":Uuid::new_v4(),"name":m["title"],"description":m["content"],"completed":false})).collect();
            let changes = json!([{"id":id,"expectedRevision":null,"changes":{"name":title,"summary":template["summary"],"description":template["content"],"icon":template["icon"],"statusId":statuses[0]["id"],"priority":p["priority"],"teamIds":teams,"leadId":text(p,"lead"),"memberIds":p["members"],"labelIds":labels,"dependencyIds":dependencies,"milestones":milestones}}]);
            events.extend(projects::apply_changes(c, a, changes).await?);
            project_ids.push(id);
            let mut seen = HashSet::new();
            for target in blocking.into_iter().filter(|p| seen.insert(p.id)) {
                let q = format!(
                    "SELECT p.id::text FROM projects p WHERE p.workspace_id=$1 AND {}",
                    policy::readable_project("p.id")
                );
                let visible: HashSet<String> = sqlx::query_scalar::<_, String>(&q)
                    .bind(&a.workspace_id)
                    .bind(policy::privileged(a))
                    .bind(&a.user_id)
                    .fetch_all(&mut *c)
                    .await?
                    .into_iter()
                    .collect();
                let mut desired: Vec<String> = array(&target.properties, "dependencyIds")
                    .iter()
                    .filter_map(|v| {
                        v.as_str()
                            .filter(|s| visible.contains(*s))
                            .map(str::to_owned)
                    })
                    .collect();
                desired.push(id.to_string());
                let mut seen = HashSet::new();
                desired.retain(|id| seen.insert(id.clone()));
                events.extend(projects::apply_changes(c,a,json!([{"id":target.id,"expectedRevision":target.revision,"changes":{"dependencyIds":desired}}])).await?);
                project_ids.push(target.id);
            }
            let mut seen = HashSet::new();
            for reference in array(p, "initiatives")
                .iter()
                .filter(|r| seen.insert(r.as_str().unwrap()))
            {
                let found:Vec<(Uuid,i32)>=sqlx::query_as("SELECT id,revision FROM initiatives WHERE workspace_id=$1 AND (id::text=$2 OR name=$2) FOR UPDATE").bind(&a.workspace_id).bind(reference.as_str().unwrap()).fetch_all(&mut *c).await?;
                if found.len() != 1 {
                    return Err(invalid(
                        "An initiative is unavailable or ambiguous. Choose an active initiative in the template.",
                    ));
                }
                let (initiative, revision) = found[0];
                events.extend(initiatives::apply_changes(c,a,json!([{"id":initiative,"expectedRevision":revision,"changes":{},"addProjectIds":[id],"removeProjectIds":[]}]),self.options.initiatives).await?);
                initiative_ids.push(initiative);
            }
            for child in array(&template, "issues") {
                if !text(&child["properties"], "project").is_empty() {
                    return Err(invalid(
                        "Remove the existing project selection from nested issues; they belong to the new project.",
                    ));
                }
                let result = creator
                    .issue(
                        c,
                        a,
                        IssueDraft {
                            title: &child["title"],
                            content: child["content"].clone(),
                            properties: &child["properties"],
                            parent: None,
                            project: Some(id),
                        },
                    )
                    .await?;
                issue_ids.push(result.value);
                events.extend(result.events);
            }
            (Kind::Project, id)
        };
        unique(&mut project_ids);
        unique(&mut initiative_ids);
        let resource_type = match kind {
            Kind::Issue => "issue",
            Kind::Project => "project",
        }
        .into();
        Ok(CommandResult {
            value: Receipt {
                kind,
                id,
                issue_ids,
                project_ids,
                initiative_ids,
            },
            resource_type,
            resource_id: id.to_string(),
            events,
        })
    }
}
pub async fn apply(
    db: &Database,
    a: &Actor,
    input: Value,
    options: Options,
) -> Result<Value, StoreError> {
    let input = contract::apply(input).map_err(|_| StoreError::InvalidInput)?;
    let result = commands::execute(
        db,
        a,
        Command {
            key: text(&input, "commandKey"),
            operation: "templates.apply@1",
            input: &input,
            status: 201,
        },
        &Apply {
            input: &input,
            options,
        },
    )
    .await;
    match result {
        Ok(result) => {
            let mut value =
                serde_json::to_value(result.value).map_err(|_| StoreError::InvalidInput)?;
            value.as_object_mut().unwrap().remove("initiativeIds");
            Ok(json!({"ok":true,"replayed":result.replayed,"value":value}))
        }
        Err(StoreError::TemplateApplication(message)) => {
            Ok(json!({"ok":false,"code":"TEMPLATE_VALIDATION","message":message}))
        }
        Err(error) => Err(error),
    }
}
