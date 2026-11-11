//! Bounded internal planning reads and exports share authorization before selection.
use crate::{
    Database, StoreError, authority::current_actor, resource_policy as policy,
    workspaces::lock_workspace,
};
use forge_core::actor::{Actor, ApiScope, Authentication};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Resource {
    Issue,
    Project,
    Initiative,
    Document,
    Label,
}
impl Resource {
    fn table(self) -> &'static str {
        match self {
            Self::Issue => "issues",
            Self::Project => "projects",
            Self::Initiative => "initiatives",
            Self::Document => "documents",
            Self::Label => "resource_labels",
        }
    }
    fn title(self) -> &'static str {
        match self {
            Self::Issue | Self::Document => "r.title",
            _ => "r.name",
        }
    }
    fn visibility(self) -> String {
        match self {
            Self::Issue => policy::readable_issue("r.id"),
            Self::Project => policy::readable_project("r.id"),
            Self::Document => policy::readable_document("r.id"),
            Self::Initiative => "TRUE".into(),
            Self::Label => format!(
                "(r.team_id IS NULL OR {})",
                policy::readable_team("r.team_id")
            ),
        }
    }
    fn contract(self, a: &Actor) -> Result<(), StoreError> {
        match self {
            Self::Issue => policy::scope(a, ApiScope::IssuesRead),
            Self::Project => policy::scope(a, ApiScope::ProjectsRead),
            _ => {
                if matches!(a.authentication, Authentication::Session { .. }) && a.scopes.is_none()
                {
                    Ok(())
                } else {
                    Err(StoreError::Forbidden)
                }
            }
        }
    }
}
// Also assigns parameter types for workspace-only resources with no team predicate.
const CONTEXT: &str = "WITH actor_parameters AS(SELECT $1::text AS workspace_id,$2::boolean AS privileged,$3::text AS user_id)";
pub async fn list(
    db: &Database,
    a: &Actor,
    kind: Resource,
    input: Value,
) -> Result<Value, StoreError> {
    let input = forge_core::planning::page(input).map_err(|_| StoreError::InvalidInput)?;
    let after: Option<Uuid> = input
        .get("after")
        .map(|v| v.as_str().unwrap().parse())
        .transpose()
        .map_err(|_| StoreError::InvalidInput)?;
    let limit = input["limit"].as_i64().unwrap();
    let search = input["search"].as_str().unwrap_or_default();
    let search = format!(
        "%{}%",
        search
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let mut tx = db.begin().await?;
    lock_workspace(&mut tx, &a.workspace_id, false).await?;
    let a = current_actor(&mut tx, a).await?;
    kind.contract(&a)?;
    let q = format!(
        "{CONTEXT} SELECT jsonb_build_object('id',r.id,'title',{}) FROM {} r WHERE r.workspace_id=$1 AND {} AND ($4::uuid IS NULL OR r.id>$4) AND {} ILIKE $5 ORDER BY r.id LIMIT $6",
        kind.title(),
        kind.table(),
        kind.visibility(),
        kind.title()
    );
    let rows: Vec<Value> = sqlx::query_scalar(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(&a))
        .bind(&a.user_id)
        .bind(after)
        .bind(search)
        .bind(limit + 1)
        .fetch_all(&mut *tx)
        .await?;
    let next = if rows.len() > limit as usize {
        rows[limit as usize - 1]["id"].clone()
    } else {
        Value::Null
    };
    let items: Vec<_> = rows.into_iter().take(limit as usize).collect();
    tx.commit().await?;
    Ok(json!({"items":items,"nextCursor":next}))
}
pub async fn export_page(
    db: &Database,
    a: &Actor,
    kind: Resource,
    input: Value,
) -> Result<Value, StoreError> {
    list(db, a, kind, input).await
}
async fn resource(
    c: &mut PgConnection,
    a: &Actor,
    kind: Resource,
    id: Uuid,
) -> Result<Option<Value>, StoreError> {
    kind.contract(a)?;
    let projection = match kind {
        Resource::Issue => format!(
            "jsonb_build_object('id',r.id,'title',r.title,'parentId',CASE WHEN {} THEN r.parent_id ELSE NULL END,'projectId',CASE WHEN {} AND {} THEN r.project_id ELSE NULL END)",
            policy::readable_issue("r.parent_id"),
            if a.has_scope(ApiScope::ProjectsRead) {
                "TRUE"
            } else {
                "FALSE"
            },
            policy::readable_project("r.project_id")
        ),
        Resource::Document => format!(
            "jsonb_build_object('id',r.id,'title',r.title,'body',r.body,'issueId',CASE WHEN {} THEN r.issue_id ELSE NULL END,'teamId',CASE WHEN {} THEN r.team_id ELSE NULL END,'projectId',CASE WHEN {} THEN r.project_id ELSE NULL END)",
            policy::readable_issue("r.issue_id"),
            policy::readable_team("r.team_id"),
            policy::readable_project("r.project_id")
        ),
        _ => format!("jsonb_build_object('id',r.id,'title',{})", kind.title()),
    };
    let q = format!(
        "{CONTEXT} SELECT {projection} FROM {} r WHERE r.workspace_id=$1 AND r.id=$4 AND {}",
        kind.table(),
        kind.visibility()
    );
    Ok(sqlx::query_scalar(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .bind(id)
        .fetch_optional(c)
        .await?)
}
pub async fn get(db: &Database, a: &Actor, kind: Resource, id: Uuid) -> Result<Value, StoreError> {
    let mut tx = db.begin().await?;
    lock_workspace(&mut tx, &a.workspace_id, false).await?;
    let a = current_actor(&mut tx, a).await?;
    let value = resource(&mut tx, &a, kind, id)
        .await?
        .unwrap_or(Value::Null);
    tx.commit().await?;
    Ok(value)
}
pub async fn rollup(
    db: &Database,
    a: &Actor,
    kind: Resource,
    id: Uuid,
) -> Result<Value, StoreError> {
    if !matches!(
        kind,
        Resource::Project | Resource::Initiative | Resource::Label
    ) {
        return Err(StoreError::InvalidInput);
    }
    let mut tx = db.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    lock_workspace(&mut tx, &a.workspace_id, false).await?;
    let a = current_actor(&mut tx, a).await?;
    kind.contract(&a)?;
    policy::scope(&a, ApiScope::IssuesRead)?;
    if resource(&mut tx, &a, kind, id).await?.is_none() {
        tx.commit().await?;
        return Ok(Value::Null);
    }
    let relation = match kind {
        Resource::Project => "i.project_id=$4".into(),
        Resource::Label => {
            "EXISTS(SELECT 1 FROM issue_labels il WHERE il.issue_id=i.id AND il.label_id=$4)".into()
        }
        _ => format!(
            "EXISTS(SELECT 1 FROM initiative_projects ip WHERE ip.initiative_id=$4 AND ip.project_id=i.project_id AND {})",
            policy::readable_project("ip.project_id")
        ),
    };
    let q = format!(
        "SELECT count(*) FROM issues i WHERE {relation} AND {}",
        policy::readable_issue("i.id")
    );
    let total: i64 = sqlx::query_scalar(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(&a))
        .bind(&a.user_id)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(json!({"issueCount":total}))
}
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Relation {
    ProjectTeams,
    InitiativeProjects,
    IssueRelations,
    IssueDocuments,
}
pub async fn related(
    db: &Database,
    a: &Actor,
    kind: Relation,
    id: Uuid,
) -> Result<Value, StoreError> {
    let mut tx = db.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    lock_workspace(&mut tx, &a.workspace_id, false).await?;
    let a = current_actor(&mut tx, a).await?;
    let (parent, projection, from, condition) = match kind {
        Relation::ProjectTeams => {
            policy::scope(&a, ApiScope::TeamsRead)?;
            (
                Resource::Project,
                "jsonb_build_object('teamId',r.team_id)",
                "project_teams r",
                format!("r.project_id=$4 AND {}", policy::readable_team("r.team_id")),
            )
        }
        Relation::InitiativeProjects => {
            policy::scope(&a, ApiScope::ProjectsRead)?;
            (
                Resource::Initiative,
                "jsonb_build_object('id',p.id,'title',p.name)",
                "initiative_projects r JOIN projects p ON p.id=r.project_id",
                format!(
                    "r.initiative_id=$4 AND {}",
                    policy::readable_project("p.id")
                ),
            )
        }
        Relation::IssueRelations => (
            Resource::Issue,
            "jsonb_build_object('id',r.related_issue_id,'kind',r.kind)",
            "issue_relations r",
            format!(
                "r.issue_id=$4 AND {}",
                policy::readable_issue("r.related_issue_id")
            ),
        ),
        Relation::IssueDocuments => {
            Resource::Document.contract(&a)?;
            (
                Resource::Issue,
                "jsonb_build_object('id',r.id,'title',r.title)",
                "documents r",
                format!("r.issue_id=$4 AND {}", policy::readable_document("r.id")),
            )
        }
    };
    if resource(&mut tx, &a, parent, id).await?.is_none() {
        tx.commit().await?;
        return Ok(json!([]));
    }
    let q = format!("SELECT {projection} FROM {from} WHERE {condition}");
    let rows: Vec<Value> = sqlx::query_scalar(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(&a))
        .bind(&a.user_id)
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(json!(rows))
}
