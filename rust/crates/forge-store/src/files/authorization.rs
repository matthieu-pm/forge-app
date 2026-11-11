use super::*;
use forge_core::{
    security::WorkspacePlan,
    subscription::{SubscriptionState, subscription_access},
};
pub(super) async fn fence(c: &mut PgConnection, a: &Actor) -> Result<(), StoreError> {
    sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
        .bind(&a.workspace_id)
        .fetch_optional(c)
        .await?
        .ok_or(StoreError::Forbidden)?;
    Ok(())
}
pub(super) async fn authorize_target(
    c: &mut PgConnection,
    a: &Actor,
    target: &Value,
    agent_ui: bool,
) -> Result<(), StoreError> {
    contract::upload_target(target.clone()).map_err(|_| StoreError::InvalidInput)?;
    let kind = text(target, "kind");
    if kind == "agent" {
        if !agent_ui {
            return Err(
                UploadError::Access("Forge Agent is not enabled for this deployment.").into(),
            );
        }
        return policy::scope(a, ApiScope::AgentsWrite);
    }
    match kind {
        "issue" => policy::scope(a, ApiScope::IssuesWrite)?,
        "project" => {
            policy::scope(a, ApiScope::ProjectsRead)?;
            policy::scope(a, ApiScope::ProjectsWrite)?;
        }
        "document"
            if !matches!(a.authentication, Authentication::Session { .. })
                || a.scopes.is_some() =>
        {
            return Err(StoreError::Forbidden);
        }
        _ => {}
    }
    let key = id(text(target, "id"))?;
    sqlx::query(
        "SELECT id FROM team_members WHERE workspace_id=$1 AND user_id=$2 ORDER BY id FOR SHARE",
    )
    .bind(&a.workspace_id)
    .bind(&a.user_id)
    .fetch_all(&mut *c)
    .await?;
    // The fence orders Rust mutations; row locks also interoperate with the
    // reference application's concurrent deletion and visibility transactions.
    let locks: &[&str] = match kind {
        "project" => &[
            "SELECT id FROM projects WHERE workspace_id=$1 AND id=$2 FOR SHARE",
            "SELECT id FROM project_teams WHERE workspace_id=$1 AND project_id=$2 ORDER BY id FOR SHARE",
            "SELECT id FROM teams WHERE workspace_id=$1 AND id IN (SELECT team_id FROM project_teams WHERE project_id=$2) ORDER BY id FOR SHARE",
        ],
        "document" => &[
            "SELECT id FROM documents WHERE workspace_id=$1 AND id=$2 FOR SHARE",
            "SELECT id FROM projects WHERE workspace_id=$1 AND id IN (SELECT project_id FROM documents WHERE id=$2) FOR SHARE",
            "SELECT id FROM project_teams WHERE workspace_id=$1 AND project_id IN (SELECT project_id FROM documents WHERE id=$2) ORDER BY id FOR SHARE",
            "SELECT id FROM issues WHERE workspace_id=$1 AND id IN (SELECT issue_id FROM documents WHERE id=$2) FOR SHARE",
            "SELECT id FROM teams WHERE workspace_id=$1 AND id IN (SELECT team_id FROM documents WHERE id=$2 UNION SELECT i.team_id FROM issues i JOIN documents d ON d.issue_id=i.id WHERE d.id=$2 UNION SELECT p.team_id FROM project_teams p JOIN documents d ON d.project_id=p.project_id WHERE d.id=$2) ORDER BY id FOR SHARE",
        ],
        _ => &[
            "SELECT id FROM issues WHERE workspace_id=$1 AND id=$2 FOR SHARE",
            "SELECT id FROM teams WHERE workspace_id=$1 AND id IN (SELECT team_id FROM issues WHERE id=$2) FOR SHARE",
        ],
    };
    for query in locks {
        sqlx::query(query)
            .bind(&a.workspace_id)
            .bind(key)
            .fetch_all(&mut *c)
            .await?;
    }
    let predicate = match kind {
        "project" => policy::readable_project("$4"),
        "document" => policy::readable_document("$4"),
        _ => policy::readable_issue("$4"),
    };
    let allowed: bool = sqlx::query_scalar(&format!("SELECT {predicate}"))
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .bind(key)
        .fetch_one(c)
        .await?;
    if !allowed {
        return Err(StoreError::Forbidden);
    }
    Ok(())
}
pub(super) async fn assert_policy(
    c: &mut PgConnection,
    a: &Actor,
    size: i32,
    mime: &str,
    now: DateTime<Utc>,
) -> Result<(), StoreError> {
    let row: Option<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(e) FROM workspace_entitlements e WHERE workspace_id=$1 FOR SHARE",
    )
    .bind(&a.workspace_id)
    .fetch_optional(&mut *c)
    .await?;
    let state = row
        .filter(crate::security::valid_subscription_row)
        .and_then(|v| serde_json::from_value::<SubscriptionState>(v).ok());
    if subscription_access(state.as_ref(), Some(now)).plan == WorkspacePlan::Free
        && size > 10_000_000
    {
        return Err(invalid(
            "Your current plan permits files up to 10000000 bytes (10 MB).",
        ));
    }
    sqlx::query(
        "INSERT INTO workspace_security_settings(workspace_id) VALUES($1) ON CONFLICT DO NOTHING",
    )
    .bind(&a.workspace_id)
    .execute(&mut *c)
    .await?;
    let (restricted,allowed):(bool,Value)=sqlx::query_as("SELECT restrict_file_uploads,allowed_upload_types FROM workspace_security_settings WHERE workspace_id=$1 FOR SHARE")
        .bind(&a.workspace_id).fetch_one(c).await?;
    if restricted
        && !mime.starts_with("image/")
        && !mime.starts_with("video/")
        && !allowed
            .as_array()
            .is_some_and(|v| v.iter().any(|t| t == mime))
    {
        return Err(invalid(
            "Workspace security policy does not allow this file type.",
        ));
    }
    Ok(())
}
