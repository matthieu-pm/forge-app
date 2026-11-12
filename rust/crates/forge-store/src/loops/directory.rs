use super::*;
impl Service {
    pub async fn read(&self, actor: &Actor, team_id: &str) -> Result<Value, StoreError> {
        let team = id(team_id)?;
        if !self.options.enabled {
            return Ok(json!({"enabled":false,"loops":[],"runs":[]}));
        }
        let mut tx = self.database.begin().await?;
        fence(&mut tx, actor).await?;
        let actor = current_actor(&mut tx, actor).await?;
        let visibility = team_access(&mut tx, &actor, team, true).await?;
        let rows:Vec<Definition>=sqlx::query_as("SELECT * FROM team_loops WHERE workspace_id=$1 AND team_id=$2 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100").bind(&actor.workspace_id).bind(team).fetch_all(&mut *tx).await?;
        let runs:Vec<Run>=sqlx::query_as("SELECT r.* FROM loop_runs r JOIN team_loops l ON l.id=r.loop_id AND l.workspace_id=r.workspace_id WHERE l.workspace_id=$1 AND l.team_id=$2 AND l.deleted_at IS NULL ORDER BY r.created_at DESC LIMIT 100").bind(&actor.workspace_id).bind(team).fetch_all(&mut *tx).await?;
        let ids: Vec<_> = rows.iter().map(|r| r.id).collect();
        let versions:Vec<(Uuid,i32,Value,DateTime<Utc>)>=sqlx::query_as("SELECT loop_id,revision,fields,created_at FROM loop_revisions WHERE workspace_id=$1 AND loop_id=ANY($2) ORDER BY created_at DESC LIMIT 100").bind(&actor.workspace_id).bind(ids).fetch_all(&mut *tx).await?;
        let agent_ids: Vec<_> = runs.iter().map(|r| r.agent_run_id).collect();
        let approvals:Vec<(Uuid,Value)>=sqlx::query_as("SELECT run_id,jsonb_build_object('id',id,'inputHash',input_hash,'summary',CASE WHEN jsonb_typeof(redacted_input_summary->'summary')='string' THEN redacted_input_summary->>'summary' ELSE 'Review this tool action' END) FROM agent_approvals WHERE workspace_id=$1 AND run_id=ANY($2) AND state='pending' AND expires_at>$3").bind(&actor.workspace_id).bind(agent_ids).bind(self.time()).fetch_all(&mut *tx).await?;
        let mut history = Vec::new();
        for run in runs {
            let row = rows.iter().find(|r| r.id == run.loop_id);
            let mut visible = row.is_some();
            if let (Some(row), Some(entity), Some(entity_id)) = (
                row,
                run.event["entity"].as_str(),
                run.event["entityId"].as_str(),
            ) && contract::ENTITIES.contains(&entity)
            {
                let mut scoped = row.clone();
                scoped.fields["teamAccess"] = json!(if visibility == "workspace"
                    && row.fields["teamAccess"] == "all-public-teams"
                    && run.fields["teamAccess"] == "all-public-teams"
                {
                    "all-public-teams"
                } else {
                    "this-team"
                });
                scoped.fields["trigger"] =
                    json!({"kind":"event","entity":entity,"event":"created"});
                let check = async {
                    let entity_id = id(entity_id).map_err(|_| StoreError::Forbidden)?;
                    context::manual(&mut tx, &actor, &scoped, Some(entity_id)).await?;
                    let raw = context::authorized(
                        &mut tx,
                        &actor,
                        entity,
                        entity_id,
                        team,
                        scoped.fields["teamAccess"] == "all-public-teams",
                    )
                    .await?;
                    contract::activity_context(&raw, &run.event)
                        .map_err(|_| StoreError::Forbidden)?;
                    Ok::<_, StoreError>(())
                }
                .await;
                match check {
                    Ok(()) => {}
                    Err(StoreError::Forbidden | StoreError::LoopPolicy(_)) => visible = false,
                    Err(e) => return Err(e),
                }
            }
            history.push(json!({"id":run.id,"loopId":run.loop_id,"state":run.state,"createdAt":stamp(run.created_at),"errorCode":if visible{run.error_code.as_deref()}else{Some("SOURCE_UNAVAILABLE")},"threadId":if visible&&run.started_at.is_some(){Some(run.thread_id)}else{None},"result":if visible{run.result.as_deref()}else{None},"approvals":approvals.iter().filter(|(id,_)|visible&&*id==run.agent_run_id).map(|(_,v)|v.clone()).collect::<Vec<_>>()}));
        }
        let result = json!({"enabled":true,"loops":rows.iter().map(Definition::project).collect::<Result<Vec<_>,_>>()?,"runs":history,"versions":versions.into_iter().map(|(id,revision,fields,at)|json!({"loopId":id,"revision":revision,"fields":fields,"publishedAt":stamp(at)})).collect::<Vec<_>>(),"choices":choices(&mut tx,&actor,team).await?});
        tx.commit().await?;
        Ok(result)
    }
}
async fn choices(c: &mut PgConnection, a: &Actor, team: Uuid) -> Result<Value, StoreError> {
    let q = format!(
        "SELECT jsonb_build_object('id',t.id,'name',t.name) FROM teams t WHERE t.workspace_id=$1 AND t.deleted_at IS NULL AND (t.id=$4 OR t.visibility='workspace') AND {} ORDER BY t.name LIMIT 100",
        policy::readable_team("t.id")
    );
    let teams: Vec<Value> = sqlx::query_scalar(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .bind(team)
        .fetch_all(&mut *c)
        .await?;
    let ids: Vec<Uuid> = teams
        .iter()
        .map(|v| value_id(&v["id"]))
        .collect::<Result<_, _>>()?;
    let q = format!(
        "SELECT jsonb_build_object('id',r.id,'name',r.title) FROM issues r WHERE r.workspace_id=$1 AND r.team_id=ANY($4) AND {} ORDER BY r.title LIMIT 100",
        policy::readable_issue("r.id")
    );
    let issues: Vec<Value> = sqlx::query_scalar(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .bind(&ids)
        .fetch_all(&mut *c)
        .await?;
    let q = format!(
        "SELECT jsonb_build_object('id',r.id,'name',r.name) FROM projects r WHERE r.workspace_id=$1 AND {} AND EXISTS(SELECT 1 FROM project_teams pt WHERE pt.project_id=r.id AND pt.team_id=ANY($4)) ORDER BY r.name LIMIT 100",
        policy::readable_project("r.id")
    );
    let projects: Vec<Value> = sqlx::query_scalar(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .bind(&ids)
        .fetch_all(&mut *c)
        .await?;
    let initiatives:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',r.id,'name',r.name) FROM initiatives r WHERE r.workspace_id=$1 AND EXISTS(SELECT 1 FROM initiative_projects ip JOIN project_teams pt ON pt.project_id=ip.project_id AND pt.workspace_id=ip.workspace_id WHERE ip.initiative_id=r.id AND pt.team_id=ANY($2)) ORDER BY r.name LIMIT 100").bind(&a.workspace_id).bind(&ids).fetch_all(&mut *c).await?;
    let cycles:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name','Cycle '||number) FROM issue_cycles WHERE workspace_id=$1 AND team_id=ANY($2) LIMIT 100").bind(&a.workspace_id).bind(&ids).fetch_all(&mut *c).await?;
    let statuses:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name',name) FROM issue_statuses WHERE workspace_id=$1 AND team_id=ANY($2) ORDER BY position LIMIT 100").bind(&a.workspace_id).bind(&ids).fetch_all(&mut *c).await?;
    let labels:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name',name) FROM resource_labels WHERE workspace_id=$1 AND (team_id IS NULL OR team_id=ANY($2)) ORDER BY name LIMIT 100").bind(&a.workspace_id).bind(&ids).fetch_all(&mut *c).await?;
    let people:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',u.id,'name',u.name) FROM \"user\" u JOIN member m ON m.user_id=u.id WHERE m.organization_id=$1 ORDER BY u.name LIMIT 100").bind(&a.workspace_id).fetch_all(c).await?;
    let none = |name: &str, items: &[Value]| {
        std::iter::once(json!({"id":"__none__","name":name}))
            .chain(items.iter().cloned())
            .collect::<Vec<_>>()
    };
    let enums = |items: &[&str]| {
        items
            .iter()
            .map(|s| json!({"id":s,"name":s}))
            .collect::<Vec<_>>()
    };
    let priority = enums(&["No priority", "Urgent", "High", "Medium", "Low"]);
    Ok(
        json!({"issue":issues,"project":projects,"issue.project":none("No project",&projects),"initiative":initiatives,"cycle":cycles,"issue.cycle":none("No cycle",&cycles),"team":teams,"status":statuses,"labels":none("No labels",&labels),"assignee":none("Unassigned",&people),"creator":people,"owner":people,"lead":people,"project.status":enums(&["Backlog","Planned","Active","Paused","Completed","Canceled"]),"initiative.status":enums(forge_core::initiatives::STATUSES),"project.priority":priority,"initiative.priority":priority,"priority":priority}),
    )
}
