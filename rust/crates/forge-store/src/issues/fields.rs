use super::*;
#[derive(FromRow)]
pub(super) struct Team {
    visibility: String,
    timezone: String,
}
pub(super) async fn require_team(
    connection: &mut PgConnection,
    actor: &Actor,
    team: Uuid,
) -> Result<Team, StoreError> {
    policy::scope(actor, ApiScope::IssuesRead)?;
    policy::scope(actor, ApiScope::IssuesWrite)?;
    let query = format!(
        "SELECT t.visibility,t.timezone FROM teams t WHERE t.id=$4 AND t.workspace_id=$1 AND {} FOR SHARE OF t",
        policy::readable_team("t.id")
    );
    let row: Team = sqlx::query_as(&query)
        .bind(&actor.workspace_id)
        .bind(policy::privileged(actor))
        .bind(&actor.user_id)
        .bind(team)
        .fetch_optional(&mut *connection)
        .await?
        .ok_or(StoreError::Forbidden)?;
    if row.visibility == "private" && !policy::privileged(actor) {
        sqlx::query("SELECT id FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3 FOR SHARE").bind(&actor.workspace_id).bind(team).bind(&actor.user_id).fetch_optional(connection).await?.ok_or(StoreError::Forbidden)?;
    }
    Ok(row)
}
pub(super) struct Resolved {
    pub status: Value,
    pub assignee: Option<String>,
    pub personal_assignee: Option<String>,
    pub assigned_on_start: bool,
    pub milestone: String,
    pub project_id: Option<Uuid>,
    pub cycle_id: Option<Uuid>,
    pub parent_id: Option<Uuid>,
    pub labels: Vec<Uuid>,
}
#[derive(FromRow)]
struct Project {
    id: Uuid,
    properties: Value,
}
pub(super) async fn imported_project(
    connection: &mut PgConnection,
    actor: &Actor,
    project: &Value,
) -> Result<Value, StoreError> {
    let mut members = std::collections::BTreeSet::new();
    if !text(project, "leadId").is_empty() {
        members.insert(text(project, "leadId"));
    }
    for id in project["memberIds"].as_array().into_iter().flatten() {
        let s = id.as_str().ok_or(StoreError::InvalidInput)?;
        if !s.is_empty() {
            members.insert(s);
        }
    }
    for user in members {
        sqlx::query("SELECT id FROM member WHERE organization_id=$1 AND user_id=$2 FOR SHARE")
            .bind(&actor.workspace_id)
            .bind(user)
            .fetch_optional(&mut *connection)
            .await?
            .ok_or(invalid(
                "The project references a member who is no longer in this workspace.",
            ))?;
    }
    let mut value = project.clone();
    let now = iso(Utc::now());
    value["creatorId"] = json!(actor.user_id);
    value["createdAt"] = json!(now);
    value["updatedAt"] = json!(now);
    value["comments"] = json!([]);
    value["updates"] = json!([]);
    value["milestoneEvents"] = json!([]);
    value["legacyFingerprint"] = json!(command_input_hash(project));
    Ok(value)
}
pub(super) async fn resolve(
    connection: &mut PgConnection,
    actor: &Actor,
    team_id: Uuid,
    input: &Value,
    edit: Option<(&Value, bool)>,
    options: IssueOptions,
) -> Result<Resolved, StoreError> {
    let team = require_team(connection, actor, team_id).await?;
    let draft = &input["draft"];
    let scope: Option<Value> = sqlx::query_scalar(
        "SELECT value FROM issue_definition_scopes WHERE workspace_id=$1 AND team_id=$2 FOR SHARE",
    )
    .bind(&actor.workspace_id)
    .bind(team_id)
    .fetch_optional(&mut *connection)
    .await?;
    let definitions = scope
        .map(forge_core::definitions::DefinitionValue::parse)
        .transpose()
        .map_err(|_| StoreError::InvalidInput)?
        .unwrap_or_else(forge_core::definitions::DefinitionValue::defaults);
    let status = definitions
        .statuses()
        .iter()
        .find(|s| s["id"] == draft["status"])
        .ok_or(invalid("Choose a status from this team's workflow."))?
        .clone();
    let mut assignment = input.get("assigneeId").cloned();
    if assignment.is_none() {
        assignment = draft
            .get("assignee")
            .map(|v| if v == "" { Value::Null } else { v.clone() });
    }
    let entering_started = edit.is_some_and(|(before, explicit)| {
        !explicit
            && text(before, "assignee").is_empty()
            && definitions
                .statuses()
                .iter()
                .any(|s| s["id"] == before["status"] && s["group"] != "started")
            && status["group"] == "started"
            && options.assign_started
    });
    let mut personal_assignee = None;
    let mut assigned_on_start = false;
    if entering_started
        || (edit.is_none()
            && (assignment.is_none()
                || draft["subIssues"].as_array().is_some_and(|a| !a.is_empty()))
            && options.personal_preferences)
    {
        let prefs: Option<(i32, Value)> = sqlx::query_as(
            "SELECT version,values FROM account_preferences WHERE user_id=$1 FOR SHARE",
        )
        .bind(&actor.user_id)
        .fetch_optional(&mut *connection)
        .await?;
        if let Some((1, values)) = prefs {
            if edit.is_none() && values["general.autoAssignToSelf"] == true {
                personal_assignee = Some(actor.user_id.clone());
            }
            if entering_started && values["general.assignStartedIssues"] == true {
                assignment = Some(json!(actor.user_id));
                assigned_on_start = true;
            }
        }
    }
    let assignee = assignment
        .map(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| personal_assignee.clone());
    let targets: std::collections::BTreeSet<_> = assignee
        .iter()
        .chain(&personal_assignee)
        .filter(|s| !s.is_empty())
        .collect();
    for user in targets {
        let role: Option<String> = sqlx::query_scalar(
            "SELECT role FROM member WHERE organization_id=$1 AND user_id=$2 FOR SHARE",
        )
        .bind(&actor.workspace_id)
        .bind(user)
        .fetch_optional(&mut *connection)
        .await?;
        let role = role.ok_or(invalid(
            "Choose an assignee who is a current member of this team.",
        ))?;
        let privileged = role
            .split(',')
            .map(str::trim)
            .any(|s| s == "owner" || s == "admin");
        if team.visibility == "private" && !privileged {
            sqlx::query("SELECT id FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3 FOR SHARE").bind(&actor.workspace_id).bind(team_id).bind(user).fetch_optional(&mut *connection).await?.ok_or(invalid("Choose an assignee who is a current member of this team."))?;
        }
    }
    let mut milestone = text(draft, "milestone").to_owned();
    if edit.is_some_and(|(before, _)| {
        draft.get("project") != before.get("project") && milestone == text(before, "milestone")
    }) {
        milestone.clear();
    }
    let mut project_id = None;
    if !text(draft, "project").is_empty() {
        let imported = input.get("projectImport");
        let query = format!(
            "SELECT p.id,p.properties FROM projects p WHERE p.workspace_id=$1 AND (p.id::text=$4 OR p.legacy_id=$4 OR p.id::text=$5 OR p.legacy_id=$5) AND {} FOR SHARE OF p",
            policy::readable_project("p.id")
        );
        let mut project: Option<Project> = sqlx::query_as(&query)
            .bind(&actor.workspace_id)
            .bind(policy::privileged(actor))
            .bind(&actor.user_id)
            .bind(text(draft, "project"))
            .bind(imported.map(|p| text(p, "id")))
            .fetch_optional(&mut *connection)
            .await?;
        if project.is_none()
            && let Some(imported) = imported
        {
            policy::scope(actor, ApiScope::ProjectsWrite)?;
            if text(imported, "id") != text(draft, "project")
                && text(imported, "name") != text(draft, "project")
            {
                return Err(invalid("The project import does not match this issue."));
            }
            let mut teams = std::collections::BTreeSet::new();
            teams.insert(team_id);
            for id in imported["teamIds"]
                .as_array()
                .ok_or(StoreError::InvalidInput)?
            {
                teams.insert(
                    Uuid::parse_str(id.as_str().ok_or(StoreError::InvalidInput)?)
                        .map_err(|_| StoreError::InvalidInput)?,
                );
            }
            for team in &teams {
                require_team(connection, actor, *team).await?;
            }
            let mut properties = imported_project(connection, actor, imported).await?;
            properties["teamIds"] = json!(teams);
            let project_id = if forge_core::text::is_uuid(text(imported, "id")) {
                id(imported, "id")?
            } else {
                Uuid::new_v4()
            };
            project=Some(sqlx::query_as("INSERT INTO projects(id,workspace_id,name,legacy_id,properties) VALUES($1,$2,$3,$4,$5) RETURNING id,properties").bind(project_id).bind(&actor.workspace_id).bind(text(imported,"name")).bind(text(imported,"id")).bind(properties).fetch_one(&mut *connection).await?);
            for team in teams {
                sqlx::query(
                    "INSERT INTO project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3)",
                )
                .bind(&actor.workspace_id)
                .bind(project_id)
                .bind(team)
                .execute(&mut *connection)
                .await?;
            }
        }
        let project = project.ok_or(invalid(
            "The linked project could not be found or imported.",
        ))?;
        let links: Vec<Uuid> =
            sqlx::query_scalar("SELECT team_id FROM project_teams WHERE project_id=$1 FOR SHARE")
                .bind(project.id)
                .fetch_all(&mut *connection)
                .await?;
        if !links.is_empty() && !links.contains(&team_id) {
            return Err(invalid("Choose a project available to this team."));
        }
        if !milestone.is_empty() {
            let milestones = project
                .properties
                .get("milestones")
                .filter(|v| !v.is_null())
                .map(|v| v.as_array().ok_or(StoreError::InvalidInput))
                .transpose()?;
            let matched = milestones.into_iter().flatten().find(|m| {
                m["id"] == milestone
                    || m["name"] == milestone
                    || m["aliases"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|v| v == &milestone))
            });
            if let Some(m) = matched {
                milestone = text(m, "id").into();
            } else if edit.is_none_or(|(before, _)| {
                text(before, "project") != project.id.to_string()
                    || text(before, "milestone") != milestone
            }) {
                return Err(invalid("Choose a milestone from the linked project."));
            }
        }
        project_id = Some(project.id);
    }
    if project_id.is_none() && !milestone.is_empty() {
        return Err(invalid("Choose a project before assigning a milestone."));
    }
    let mut cycle_id = None;
    if !text(draft, "cycle").is_empty() {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,4055))")
            .bind(team_id.to_string())
            .execute(&mut *connection)
            .await?;
        cycle_id=sqlx::query_scalar("SELECT id FROM issue_cycles WHERE workspace_id=$1 AND team_id=$2 AND (id::text=$3 OR start_date=$3)").bind(&actor.workspace_id).bind(team_id).bind(text(draft,"cycle")).fetch_optional(&mut *connection).await?;
        if cycle_id.is_none()
            && input.get("legacyId").is_some()
            && let Some(cycle) = input.get("cycleImport")
        {
            if text(cycle, "startDate") != text(draft, "cycle")
                || text(cycle, "endDate") < text(cycle, "startDate")
            {
                return Err(invalid("Choose a valid cycle date range."));
            }
            cycle_id=Some(sqlx::query_scalar("INSERT INTO issue_cycles(workspace_id,team_id,start_date,end_date,timezone) VALUES($1,$2,$3,$4,$5) RETURNING id").bind(&actor.workspace_id).bind(team_id).bind(text(cycle,"startDate")).bind(text(cycle,"endDate")).bind(&team.timezone).fetch_one(&mut *connection).await?);
        }
        if cycle_id.is_none() {
            return Err(invalid("The linked cycle could not be found or imported."));
        }
    }
    let mut parent_id = None;
    if !text(draft, "parentId").is_empty() {
        let query = format!(
            "SELECT p.id,p.team_id FROM issues p WHERE p.workspace_id=$1 AND (p.id::text=$4 OR (p.team_id=$5 AND p.legacy_id=$4)) AND {} FOR SHARE OF p",
            policy::readable_issue("p.id")
        );
        let (id, parent_team): (Uuid, Uuid) = sqlx::query_as(&query)
            .bind(&actor.workspace_id)
            .bind(policy::privileged(actor))
            .bind(&actor.user_id)
            .bind(text(draft, "parentId"))
            .bind(team_id)
            .fetch_optional(&mut *connection)
            .await?
            .ok_or(invalid(
                "The parent issue is unavailable. Import its parent first.",
            ))?;
        require_team(connection, actor, parent_team).await?;
        parent_id = Some(id);
    }
    let names: std::collections::BTreeSet<_> = text(draft, "labels")
        .split(',')
        .map(forge_core::text::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let names: Vec<_> = names.into_iter().collect();
    let labels:Vec<(Uuid,String,Option<Value>)>=sqlx::query_as("SELECT id,name,definition FROM resource_labels WHERE workspace_id=$1 AND (team_id IS NULL OR team_id=$2) AND name=ANY($3) FOR SHARE").bind(&actor.workspace_id).bind(team_id).bind(&names).fetch_all(connection).await?;
    let previous_names: Vec<_> = edit
        .map_or("", |(before, _)| text(before, "labels"))
        .split(',')
        .map(forge_core::text::trim)
        .collect();
    let labels: Vec<_> = labels
        .into_iter()
        .filter(|(_, name, d)| {
            d.as_ref().is_none_or(|d| d["archived"] != true)
                || previous_names.contains(&name.as_str())
        })
        .collect();
    if names
        .iter()
        .any(|name| labels.iter().filter(|(_, n, _)| n == name).count() != 1)
    {
        return Err(invalid(
            "Choose active, unambiguous labels available to this team.",
        ));
    }
    Ok(Resolved {
        status,
        assignee,
        personal_assignee,
        assigned_on_start,
        milestone,
        project_id,
        cycle_id,
        parent_id,
        labels: labels.into_iter().map(|(id, _, _)| id).collect(),
    })
}
