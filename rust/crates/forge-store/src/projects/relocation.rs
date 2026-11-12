use super::*;
pub(super) struct Relocated {
    pub milestones: Vec<Value>,
    pub event: Value,
    pub events: Vec<OutboxEvent>,
}
#[derive(FromRow)]
struct Issue {
    id: Uuid,
    team_id: Uuid,
    properties: Value,
    readable: bool,
    purge_started: bool,
}
pub(super) async fn relocate(
    c: &mut PgConnection,
    a: &Actor,
    source: &Row,
    relocation: &Value,
    now: &str,
) -> Result<Relocated, StoreError> {
    policy::scope(a, ApiScope::IssuesRead)?;
    policy::scope(a, ApiScope::IssuesWrite)?;
    let milestones = array(&source.properties, "milestones");
    let milestone = milestones
        .iter()
        .find(|m| m["id"] == relocation["milestoneId"])
        .ok_or_else(|| {
            invalid("This milestone is no longer available. Load the latest project.")
        })?;
    if relocation["targetId"] == source.id.to_string()
        || (relocation.get("targetId").is_some() && relocation.get("convertId").is_some())
    {
        return Err(invalid("Choose another destination project."));
    }
    let source_links = links(c, source.id).await?;
    let mut target = if relocation.get("targetId").is_some() {
        let target_id = id(relocation, "targetId")?;
        visible(c, a, target_id).await?;
        let row: Row = sqlx::query_as(
            "SELECT id,name,revision,properties FROM projects WHERE id=$1 FOR UPDATE",
        )
        .bind(target_id)
        .fetch_one(&mut *c)
        .await?;
        if relocation["targetRevision"] != row.revision {
            return Err(invalid(
                "The destination is unavailable or changed. Load the latest project before retrying.",
            ));
        }
        Some(row)
    } else {
        None
    };
    let convert = relocation.get("convertId").is_some();
    if convert {
        for team in &source_links {
            require_team(c, a, *team).await?;
        }
        let mut properties = json!({"status":"Backlog","health":"Update missing","creatorId":a.user_id,"createdAt":now,"updatedAt":now});
        for key in ["description", "targetDate"] {
            if let Some(v) = milestone.get(key) {
                properties[key] = v.clone();
            }
        }
        let row:Row=sqlx::query_as("INSERT INTO projects(id,workspace_id,name,properties) VALUES($1,$2,$3,$4) RETURNING id,name,revision,properties").bind(id(relocation,"convertId")?).bind(&a.workspace_id).bind(text(milestone,"name")).bind(properties).fetch_one(&mut *c).await?;
        for team in &source_links {
            sqlx::query(
                "INSERT INTO project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3)",
            )
            .bind(&a.workspace_id)
            .bind(row.id)
            .bind(team)
            .execute(&mut *c)
            .await?;
        }
        target = Some(row);
    }
    let target_links = if let Some(t) = &target {
        links(c, t.id).await?
    } else {
        vec![]
    };
    let values: Vec<_> = [&milestone["id"], &milestone["name"]]
        .into_iter()
        .chain(array(milestone, "aliases"))
        .filter_map(Value::as_str)
        .collect();
    let affected_teams:Vec<Uuid>=sqlx::query_scalar("SELECT DISTINCT team_id FROM issues WHERE workspace_id=$1 AND project_id=$2 AND properties->>'milestone'=ANY($3) ORDER BY team_id").bind(&a.workspace_id).bind(source.id).bind(&values).fetch_all(&mut *c).await?;
    for team in affected_teams {
        require_team(c, a, team).await?;
    }
    let q = format!(
        "SELECT i.id,i.team_id,i.properties,{} AS readable,i.purge_started_at IS NOT NULL AS purge_started FROM issues i WHERE i.workspace_id=$1 AND i.project_id=$4 AND i.properties->>'milestone'=ANY($5) ORDER BY i.id FOR UPDATE OF i",
        policy::retained_issue(a, "i.id")
    );
    let affected: Vec<Issue> = sqlx::query_as(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .bind(source.id)
        .bind(&values)
        .fetch_all(&mut *c)
        .await?;
    if affected.iter().any(|i| {
        !i.readable
            || i.purge_started
            || (!target_links.is_empty() && !target_links.contains(&i.team_id))
    }) {
        return Err(StoreError::Forbidden);
    }
    let mut events = vec![];
    for issue in affected {
        let next_milestone = if target.is_some() && !convert {
            text(milestone, "id")
        } else {
            ""
        };
        let next_project = target.as_ref().map_or(source.id, |t| t.id);
        let mut changes = vec![
            json!({"field":"milestone","from":text(&issue.properties,"milestone"),"to":next_milestone}),
        ];
        if next_project != source.id {
            changes.push(json!({"field":"project","from":source.id,"to":next_project}));
        }
        let mut properties = issue.properties;
        properties["project"] = json!(next_project);
        properties["milestone"] = json!(next_milestone);
        sqlx::query("UPDATE issues SET project_id=$1,properties=$2 WHERE id=$3")
            .bind(next_project)
            .bind(properties)
            .bind(issue.id)
            .execute(&mut *c)
            .await?;
        events.push(event("issue.updated",json!({"issueId":issue.id,"teamId":issue.team_id,"history":{"version":1,"changes":changes}})));
    }
    if let Some(target) = &target {
        if !convert {
            let mut milestones = array(&target.properties, "milestones").to_vec();
            milestones.push(milestone.clone());
            contract::unique_milestones(&milestones).map_err(|e| invalid(e.0))?;
            let mut p = target.properties.clone();
            p["milestones"] = json!(milestones);
            p["updatedAt"] = json!(now);
            sqlx::query("UPDATE projects SET properties=$1 WHERE id=$2")
                .bind(p)
                .bind(target.id)
                .execute(&mut *c)
                .await?;
        }
        events.push(event(
            if convert {
                "project.created"
            } else {
                "project.updated"
            },
            json!({"projectId":target.id}),
        ));
    }
    Ok(Relocated {
        milestones: milestones
            .iter()
            .filter(|m| m["id"] != milestone["id"])
            .cloned()
            .collect(),
        event: json!({"id":Uuid::new_v4(),"authorId":a.user_id,"createdAt":now,"text":format!("{} milestone {}",if target.is_some(){if convert{"converted"}else{"moved"}}else{"deleted"},text(milestone,"name"))}),
        events,
    })
}
