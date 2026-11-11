use super::*;
use crate::commands::OutboxEvent;
pub(super) struct Created {
    pub id: String,
    pub events: Vec<OutboxEvent>,
    pub changed_project: Option<String>,
}
fn event(topic: &str, payload: Value) -> OutboxEvent {
    OutboxEvent {
        topic: topic.into(),
        payload: payload.as_object().unwrap().clone(),
    }
}
pub(super) async fn create(
    c: &mut PgConnection,
    a: &Actor,
    m: &Value,
    e: &Value,
    both: bool,
    options: ImportOptions,
) -> Result<Created, StoreError> {
    let content = e.get("content");
    let result = if let Some(content) = content {
        require_module(e, modules(c, a, options).await?)?;
        if content["kind"] == "milestone" {
            let project =
                references::resolve(c, a, m, e, "project", text(content, "projectId"), options)
                    .await?;
            for parent in array(m, "entries").iter().filter(|p| {
                p["kind"] == "project" && p["state"] == "saved" && p["canonicalId"] == project
            }) {
                let live = target(c, a, parent, &project, false, options).await?;
                if live.as_ref().map(|r| &r["fingerprint"]) != Some(&parent["targetFingerprint"]) {
                    return Err(StoreError::Planning(
                        "The linked project changed. Retry unresolved records and review it before extending its milestones.",
                    ));
                }
            }
        }
        create_content(c, a, m, e, both, options).await?
    } else if e["kind"] == "project" {
        let p = &e["project"];
        let teams: Vec<Uuid> = array(p, "teamIds")
            .iter()
            .map(|v| {
                v.as_str()
                    .ok_or(StoreError::InvalidInput)?
                    .parse()
                    .map_err(|_| StoreError::InvalidInput)
            })
            .collect::<Result<_, _>>()?;
        for t in &teams {
            policy::team(c, a, *t).await?;
        }
        let imported = crate::issues::import_project_snapshot(c, a, p).await?;
        let mut properties = json!({"name":p["name"],"status":p["status"],"health":p["health"],"summary":p.get("summary").unwrap_or(&json!("")),"description":p.get("description").unwrap_or(&Value::Null),"leadId":p.get("leadId").unwrap_or(&json!("")),"memberIds":p.get("memberIds").unwrap_or(&json!([])),"teamIds":p["teamIds"],"startDate":p.get("startDate").unwrap_or(&json!("")),"targetDate":p.get("targetDate").unwrap_or(&json!("")),"creatorId":imported["creatorId"],"createdAt":imported["createdAt"],"updatedAt":imported["updatedAt"],"legacyFingerprint":imported["legacyFingerprint"],"dependencyIds":[],"milestones":[],"resources":[],"comments":[],"updates":[],"labelIds":[]});
        for k in ["icon", "priority"] {
            if let Some(v) = p.get(k) {
                properties[k] = v.clone();
            }
        }
        let uid:Uuid=sqlx::query_scalar("INSERT INTO projects(workspace_id,name,legacy_id,properties) VALUES($1,$2,$3,$4) RETURNING id").bind(&a.workspace_id).bind(text(p,"name")).bind(if both{None}else{Some(text(e,"legacyId"))}).bind(properties).fetch_one(&mut *c).await?;
        for t in teams.into_iter().collect::<std::collections::BTreeSet<_>>() {
            sqlx::query(
                "INSERT INTO project_teams(workspace_id,project_id,team_id) VALUES($1,$2,$3)",
            )
            .bind(&a.workspace_id)
            .bind(uid)
            .bind(t)
            .execute(&mut *c)
            .await?;
        }
        Created {
            id: uid.to_string(),
            events: vec![],
            changed_project: None,
        }
    } else {
        let mut draft = e["draft"].clone();
        for k in [
            "attachments",
            "comments",
            "activity",
            "reactions",
            "subIssues",
        ] {
            draft[k] = json!([]);
        }
        for k in [
            "subscribers",
            "recurrence",
            "agent",
            "agentSession",
            "milestone",
        ] {
            draft[k] = json!("");
        }
        draft["favorite"] = json!(false);
        draft["parentId"] = json!(
            references::resolve(c, a, m, e, "issue", text(&draft, "parentId"), options).await?
        );
        draft["project"] = json!(
            references::resolve(c, a, m, e, "project", text(&draft, "project"), options).await?
        );
        if m["modules"]["milestones"] == true && !text(&e["draft"], "milestone").is_empty() {
            draft["milestone"] = json!(
                references::resolve(
                    c,
                    a,
                    m,
                    e,
                    "milestone",
                    &format!(
                        "{}::{}",
                        text(&e["draft"], "project"),
                        text(&e["draft"], "milestone")
                    ),
                    options
                )
                .await?
            );
        }
        let uid = crate::issues::import_issue(
            c,
            a,
            id(e, "teamId")?,
            draft,
            if both {
                None
            } else {
                Some(text(e, "legacyId"))
            },
            text(e, "fingerprint"),
        )
        .await?;
        Created {
            id: uid.to_string(),
            events: vec![],
            changed_project: None,
        }
    };
    review::record_alias(c, a, e, &result.id, options).await?;
    Ok(result)
}
async fn create_content(
    c: &mut PgConnection,
    a: &Actor,
    m: &Value,
    e: &Value,
    both: bool,
    options: ImportOptions,
) -> Result<Created, StoreError> {
    let content = &e["content"];
    let fields = &content["fields"];
    let uid = if content["kind"] == "document" && !both {
        legacy_uuid(text(content, "sourceId")).unwrap_or_else(Uuid::new_v4)
    } else {
        Uuid::new_v4()
    };
    let mut result = Created {
        id: uid.to_string(),
        events: vec![],
        changed_project: None,
    };
    match text(content, "kind") {
        "initiative" => {
            let mut projects = vec![];
            for p in array(content, "projectIds") {
                projects.push(
                    references::resolve(
                        c,
                        a,
                        m,
                        e,
                        "project",
                        p.as_str().ok_or(StoreError::InvalidInput)?,
                        options,
                    )
                    .await?,
                );
            }
            let fields = forge_core::initiatives::fields(fields.clone(), false, false)
                .map_err(|_| StoreError::InvalidInput)?;
            result.events=crate::initiatives::import_changes(c,a,json!([{"id":uid,"expectedRevision":null,"changes":fields,"addProjectIds":projects}]),crate::initiatives::InitiativeOptions{enabled:options.modules.initiatives}).await?;
        }
        "milestone" => {
            let project =
                references::resolve(c, a, m, e, "project", text(content, "projectId"), options)
                    .await?;
            let project_id = project.parse().map_err(|_| StoreError::InvalidInput)?;
            crate::projects::lock_project(c, a, project_id).await?;
            let (revision,properties):(i32,Value)=sqlx::query_as("SELECT revision,properties FROM projects WHERE id=$1 AND workspace_id=$2 FOR UPDATE").bind(project_id).bind(&a.workspace_id).fetch_one(&mut *c).await?;
            let mut milestones = array(&properties, "milestones").to_vec();
            if milestones
                .iter()
                .any(|m| m["id"] == fields["id"] || m["name"] == fields["name"])
            {
                return Err(StoreError::Planning(
                    "A milestone with this identity or name already exists. Review the retained source.",
                ));
            }
            let mut milestone = fields.clone();
            milestone["id"] = json!(uid);
            milestones.push(milestone);
            result.events=crate::projects::import_changes(c,a,json!([{"id":project_id,"expectedRevision":revision,"changes":{"milestones":milestones}}])).await?;
            result.changed_project = Some(project);
        }
        "document" => {
            let project = if text(content, "projectId").is_empty() {
                None
            } else {
                Some(
                    references::resolve(c, a, m, e, "project", text(content, "projectId"), options)
                        .await?
                        .parse::<Uuid>()
                        .map_err(|_| StoreError::InvalidInput)?,
                )
            };
            let team = if let Some(project) = project {
                crate::projects::lock_project(c, a, project).await?;
                None
            } else {
                let team = id(e, "teamId")?;
                policy::team(c, a, team).await?;
                Some(team)
            };
            let section = if text(content, "sectionId").is_empty() {
                None
            } else {
                Some(
                    references::resolve(
                        c,
                        a,
                        m,
                        e,
                        "resource",
                        &format!("section:{}", text(content, "sectionId")),
                        options,
                    )
                    .await?,
                )
            };
            if let Some(section) = &section {
                if project.is_some() {
                    return Err(StoreError::Planning(
                        "Project documents cannot be placed in a team resource section.",
                    ));
                }
                if !modules(c, a, options).await?.resources {
                    return Err(StoreError::Planning("Resource sections are unavailable."));
                }
                let board:Option<Value>=sqlx::query_scalar("SELECT fields FROM team_resource_boards WHERE workspace_id=$1 AND team_id=$2 FOR SHARE").bind(&a.workspace_id).bind(team).fetch_optional(&mut *c).await?;
                if !board.is_some_and(|b| array(&b, "sections").iter().any(|s| s["id"] == *section))
                {
                    return Err(StoreError::Planning(
                        "This resource section is no longer available.",
                    ));
                }
            }
            let mut fields = fields.clone();
            fields["sectionId"] = json!(section);
            let created = Utc::now();
            sqlx::query("INSERT INTO documents(id,workspace_id,team_id,project_id,owner_id,updated_by_id,title,body,content,icon,section_id,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,1,$11,$11)").bind(uid).bind(&a.workspace_id).bind(team).bind(project).bind(&a.user_id).bind(text(&fields,"title")).bind(&fields["body"]).bind(forge_core::documents::plain_text(&fields["body"])).bind(&fields["icon"]).bind(section).bind(created).execute(&mut *c).await?;
            sqlx::query("INSERT INTO document_revisions(workspace_id,document_id,revision,snapshot,author_id,created_at) VALUES($1,$2,1,$3,$4,$5)").bind(&a.workspace_id).bind(uid).bind(fields).bind(&a.user_id).bind(created).execute(&mut *c).await?;
            result.events.push(event(
                "document.create",
                json!({"documentId":uid,"revision":1}),
            ));
        }
        "view" => {
            let definition = references::mapped_view(c, a, m, e, options).await?;
            crate::saved_views::validate_references(c, a, &definition, true).await?;
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM saved_views WHERE workspace_id=$1 AND deleted_at IS NULL",
            )
            .bind(&a.workspace_id)
            .fetch_one(&mut *c)
            .await?;
            if count >= 500 {
                return Err(StoreError::Planning(
                    "This workspace has reached its limit of 500 saved views.",
                ));
            }
            sqlx::query("INSERT INTO saved_views(id,workspace_id,owner_id,visibility,team_id,definition,revision) VALUES($1,$2,$3,$4,$5,$6,1)").bind(uid).bind(&a.workspace_id).bind(&a.user_id).bind(text(&definition,"visibility")).bind(definition["teamId"].as_str().map(str::parse::<Uuid>).transpose().map_err(|_|StoreError::InvalidInput)?).bind(&definition).execute(&mut *c).await?;
            result
                .events
                .push(event("saved-view.save", json!({"viewId":uid,"revision":1})));
        }
        "resource" => {
            let team = id(e, "teamId")?;
            policy::team(c, a, team).await?;
            let board:Option<(i32,Value)>=sqlx::query_as("SELECT revision,fields FROM team_resource_boards WHERE workspace_id=$1 AND team_id=$2 FOR UPDATE").bind(&a.workspace_id).bind(team).fetch_optional(&mut *c).await?;
            let (revision, mut board) =
                board.unwrap_or((0, json!({"sections":[],"links":[],"order":[]})));
            if fields.get("name").is_some() {
                board["sections"]
                    .as_array_mut()
                    .ok_or(StoreError::InvalidInput)?
                    .push(json!({"id":uid,"name":fields["name"]}));
            } else {
                let mut link = fields.clone();
                link["id"] = json!(uid);
                link["sectionId"] = if text(content, "sectionId").is_empty() {
                    Value::Null
                } else {
                    json!(
                        references::resolve(
                            c,
                            a,
                            m,
                            e,
                            "resource",
                            &format!("section:{}", text(content, "sectionId")),
                            options
                        )
                        .await?
                    )
                };
                board["links"]
                    .as_array_mut()
                    .ok_or(StoreError::InvalidInput)?
                    .push(link);
                board["order"]
                    .as_array_mut()
                    .ok_or(StoreError::InvalidInput)?
                    .push(json!(format!("link:{uid}")));
            }
            let fields =
                forge_core::team_resources::fields(board).map_err(|_| StoreError::InvalidInput)?;
            let revision = revision.checked_add(1).ok_or(StoreError::InvalidInput)?;
            sqlx::query("INSERT INTO team_resource_boards(team_id,workspace_id,revision,fields) VALUES($1,$2,$3,$4) ON CONFLICT(team_id) DO UPDATE SET revision=EXCLUDED.revision,fields=EXCLUDED.fields,updated_at=now()").bind(team).bind(&a.workspace_id).bind(revision).bind(fields).execute(c).await?;
            result.events.push(event(
                "team.resources.updated",
                json!({"teamId":team,"revision":revision}),
            ));
        }
        _ => return Err(StoreError::InvalidInput),
    }
    Ok(result)
}
