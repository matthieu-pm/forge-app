use super::*;
pub(super) async fn authorized(
    c: &mut PgConnection,
    a: &Actor,
    entity: &str,
    id: Uuid,
    own: Uuid,
    all_public: bool,
) -> Result<Value, StoreError> {
    let (table, condition) = match entity {
        "issue" => ("issues", policy::readable_issue("r.id")),
        "project" => ("projects", policy::readable_project("r.id")),
        "team" => ("teams", policy::readable_team("r.id")),
        "cycle" => ("issue_cycles", policy::readable_team("r.team_id")),
        "initiative" => (
            "initiatives",
            format!(
                "EXISTS(SELECT 1 FROM initiative_projects ip JOIN project_teams pt ON pt.project_id=ip.project_id AND pt.workspace_id=ip.workspace_id WHERE ip.initiative_id=r.id AND ip.workspace_id=$1 AND (CASE WHEN $6 THEN ({} AND EXISTS(SELECT 1 FROM teams t WHERE t.id=pt.team_id AND t.visibility='workspace')) ELSE pt.team_id=$5 END))",
                policy::readable_team("pt.team_id")
            ),
        ),
        _ => return Err(StoreError::InvalidInput),
    };
    let query = format!(
        "SELECT to_jsonb(r) FROM {table} r WHERE r.workspace_id=$1 AND r.id=$4 AND {condition}"
    );
    let mut q = sqlx::query_scalar(&query)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .bind(id);
    if entity == "initiative" {
        q = q.bind(own).bind(all_public);
    }
    q.fetch_optional(c).await?.ok_or(StoreError::Forbidden)
}
pub(super) async fn current(
    c: &mut PgConnection,
    a: &Actor,
    entity: &str,
    id: Uuid,
    own: Uuid,
    all_public: bool,
) -> Result<Value, StoreError> {
    authorized(c, a, entity, id, own, all_public).await?;
    let mut raw: Value =
        sqlx::query_scalar::<_, Option<Value>>("SELECT forge_loop_snapshot($1,$2,$3)")
            .bind(entity)
            .bind(id)
            .bind(&a.workspace_id)
            .fetch_one(&mut *c)
            .await?
            .ok_or(StoreError::Forbidden)?;
    let ids: Vec<Uuid> = contract::snapshot_list(&raw["teamIds"])
        .iter()
        .map(|s| super::id(s))
        .collect::<Result<_, _>>()?;
    if !ids.is_empty() {
        let q = format!(
            "SELECT t.id FROM teams t WHERE t.id=ANY($4) AND {} AND (CASE WHEN $6 THEN t.visibility='workspace' ELSE t.id=$5 END) ORDER BY t.id",
            policy::readable_team("t.id")
        );
        let readable: Vec<Uuid> = sqlx::query_scalar(&q)
            .bind(&a.workspace_id)
            .bind(policy::privileged(a))
            .bind(&a.user_id)
            .bind(&ids)
            .bind(own)
            .bind(all_public)
            .fetch_all(&mut *c)
            .await?;
        raw["teamIds"] = json!(readable);
    }
    if entity == "initiative" {
        let ids: Vec<Uuid> = contract::snapshot_list(&raw["projectIds"])
            .iter()
            .map(|s| super::id(s))
            .collect::<Result<_, _>>()?;
        let teams: Vec<Uuid> = contract::snapshot_list(&raw["teamIds"])
            .iter()
            .map(|s| super::id(s))
            .collect::<Result<_, _>>()?;
        let q = format!(
            "SELECT p.id FROM projects p WHERE p.id=ANY($4) AND {} AND EXISTS(SELECT 1 FROM project_teams pt WHERE pt.workspace_id=$1 AND pt.project_id=p.id AND pt.team_id=ANY($5)) ORDER BY p.id",
            policy::readable_project("p.id")
        );
        let visible: Vec<Uuid> = sqlx::query_scalar(&q)
            .bind(&a.workspace_id)
            .bind(policy::privileged(a))
            .bind(&a.user_id)
            .bind(&ids)
            .bind(&teams)
            .fetch_all(&mut *c)
            .await?;
        raw["projectIds"] = json!(visible);
    }
    Ok(raw)
}
pub(super) async fn manual(
    c: &mut PgConnection,
    a: &Actor,
    row: &Definition,
    id: Option<Uuid>,
) -> Result<Value, StoreError> {
    if row.fields["trigger"]["kind"] != "event" {
        return Ok(json!({"kind":"manual","teamId":row.team_id}));
    }
    let id = id.ok_or(StoreError::LoopPolicy(
        "Choose the item to run this Loop on.",
    ))?;
    let entity = row.fields["trigger"]["entity"]
        .as_str()
        .ok_or(StoreError::InvalidInput)?;
    let all_public = row.fields["teamAccess"] == "all-public-teams";
    let raw = current(c, a, entity, id, row.team_id, all_public).await?;
    let teams = contract::snapshot_list(&raw["teamIds"]);
    if if all_public {
        teams.is_empty()
    } else {
        !teams.contains(&row.team_id.to_string())
    } {
        return Err(StoreError::Forbidden);
    }
    Ok(
        json!({"kind":"manual","entity":entity,"entityId":id,"context":contract::normalize_snapshot(entity,&raw)}),
    )
}
