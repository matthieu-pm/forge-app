use super::*;
pub(crate) async fn import_project_snapshot(
    c: &mut PgConnection,
    a: &Actor,
    p: &Value,
) -> Result<Value, StoreError> {
    fields::imported_project(c, a, p).await
}
pub(crate) async fn import_issue(
    c: &mut PgConnection,
    a: &Actor,
    team: Uuid,
    mut draft: Value,
    legacy: Option<&str>,
    fingerprint: &str,
) -> Result<Uuid, StoreError> {
    let cycle = text(&draft, "cycle").to_owned();
    if !cycle.is_empty() && !forge_core::text::is_uuid(&cycle) {
        forge_core::cycles::add_days(&cycle, 0).map_err(|_| {
            invalid("This cycle needs an explicit valid date or canonical ID mapping.")
        })?;
        draft["cycle"] = json!(cycles::import_date(c, a, team, &cycle).await?);
    }
    let input = json!({"draft":draft,"assigneeId":if text(&draft,"assignee").is_empty(){Value::Null}else{draft["assignee"].clone()}});
    let resolved = fields::resolve(c, a, team, &input, None, IssueOptions::default()).await?;
    sqlx::query("INSERT INTO team_issue_numbers(team_id) VALUES($1) ON CONFLICT DO NOTHING")
        .bind(team)
        .execute(&mut *c)
        .await?;
    let number:i32=sqlx::query_scalar("UPDATE team_issue_numbers SET last_number=last_number+1 WHERE team_id=$1 RETURNING last_number").bind(team).fetch_one(&mut *c).await?;
    draft["legacyFingerprint"] = json!(fingerprint);
    draft["completedAt"] = if resolved.status["group"] == "completed" {
        json!(iso(Utc::now()))
    } else {
        Value::Null
    };
    draft["statusChangedAt"] = json!(iso(Utc::now()));
    let uid:Uuid=sqlx::query_scalar("INSERT INTO issues(workspace_id,team_id,number,title,status_id,project_id,parent_id,cycle_id,assignee_id,creator_id,legacy_id,properties) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id").bind(&a.workspace_id).bind(team).bind(number).bind(text(&draft,"title")).bind(text(&resolved.status,"id")).bind(resolved.project_id).bind(resolved.parent_id).bind(resolved.cycle_id).bind(resolved.assignee).bind(&a.user_id).bind(legacy).bind(&draft).fetch_one(&mut *c).await?;
    for label in resolved.labels {
        sqlx::query("INSERT INTO issue_labels(workspace_id,issue_id,label_id) VALUES($1,$2,$3)")
            .bind(&a.workspace_id)
            .bind(uid)
            .bind(label)
            .execute(&mut *c)
            .await?;
    }
    Ok(uid)
}
