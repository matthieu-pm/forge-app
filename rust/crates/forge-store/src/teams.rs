use crate::{
    Database, StoreError,
    authority::current_actor,
    commands::{self, Command, CommandHandler, CommandResult, OutboxEvent},
    security,
    workspaces::lock_workspace,
};
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use forge_core::{
    actor::{Actor, ApiScope, Authentication},
    security::SecurityAction,
    teams::{CreateTeam, RECOVERY_DAYS, TeamError, TeamSettings, TeamSummary, slugify_team_name},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

#[derive(Debug, FromRow)]
struct TeamRow {
    id: Uuid,
    slug: String,
    identifier: String,
    name: String,
    icon_kind: String,
    icon_value: String,
    color: String,
    timezone: String,
    description: String,
    visibility: String,
    estimation_scheme: String,
    issue_email_enabled: bool,
    detailed_history_enabled: bool,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    deleted_at: Option<DateTime<Utc>>,
}
impl TeamRow {
    fn summary(&self) -> Result<TeamSummary, StoreError> {
        serde_json::from_value(json!({"id":self.id,"slug":self.slug,"identifier":self.identifier,"name":self.name,"icon":{"kind":self.icon_kind,"value":self.icon_value,"color":self.color},"timezone":self.timezone,"description":self.description,"visibility":self.visibility,"estimationScheme":self.estimation_scheme,"issueEmailEnabled":self.issue_email_enabled,"detailedHistoryEnabled":self.detailed_history_enabled,"createdAt":self.created_at})).map_err(|_|StoreError::InvalidInput)
    }
}

#[derive(Debug, Clone)]
pub enum Selector {
    Id(Uuid),
    Slug(String),
}
impl Selector {
    fn column(&self) -> &'static str {
        match self {
            Self::Id(_) => "t.id::text",
            Self::Slug(_) => "t.slug",
        }
    }
    fn value(&self) -> String {
        match self {
            Self::Id(id) => id.to_string(),
            Self::Slug(slug) => slug.clone(),
        }
    }
}
fn require_read(actor: &Actor) -> Result<(), StoreError> {
    if actor.has_scope(ApiScope::TeamsRead) {
        Ok(())
    } else {
        Err(StoreError::Forbidden)
    }
}
fn require_manage(actor: &Actor) -> Result<(), StoreError> {
    if actor.can_manage_teams() {
        Ok(())
    } else {
        Err(StoreError::Forbidden)
    }
}

/// Shared by admissions and membership/lifecycle writes. KEY SHARE, held by
/// command receipts and foreign keys, remains compatible with this fence.
async fn mutation_fence(connection: &mut PgConnection, workspace: &str) -> Result<(), StoreError> {
    sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
        .bind(workspace)
        .fetch_optional(connection)
        .await?
        .ok_or(StoreError::Forbidden)?;
    Ok(())
}

async fn select_team(
    connection: &mut PgConnection,
    actor: &Actor,
    selector: &Selector,
    archived: bool,
    lock: bool,
) -> Result<Option<TeamRow>, StoreError> {
    let query = format!(
        "SELECT t.* FROM teams t WHERE t.workspace_id=$1 AND {}=$2 AND {} AND (t.visibility='workspace' OR $3 OR EXISTS(SELECT 1 FROM team_members tm WHERE tm.workspace_id=t.workspace_id AND tm.team_id=t.id AND tm.user_id=$4)) {}",
        selector.column(),
        if archived {
            "t.deleted_at>clock_timestamp()-interval '30 days'"
        } else {
            "t.deleted_at IS NULL"
        },
        if lock {
            "FOR UPDATE OF t"
        } else {
            "FOR SHARE OF t"
        }
    );
    Ok(sqlx::query_as::<_, TeamRow>(&query)
        .bind(&actor.workspace_id)
        .bind(selector.value())
        .bind(actor.can_read_all_private_teams())
        .bind(&actor.user_id)
        .fetch_optional(connection)
        .await?)
}

async fn authorize_creation(
    connection: &mut PgConnection,
    actor: &Actor,
    value: Option<&TeamSummary>,
) -> Result<(), StoreError> {
    require_read(actor)?;
    if !actor.has_scope(ApiScope::TeamsWrite) {
        return Err(StoreError::Forbidden);
    }
    if let Some(team) = value {
        select_team(connection, actor, &Selector::Id(team.id), false, false)
            .await?
            .ok_or(StoreError::Forbidden)?;
    } else {
        mutation_fence(connection, &actor.workspace_id).await?;
        if !security::settings(connection, &actor.workspace_id)
            .await?
            .allows(actor, SecurityAction::TeamsCreate)
        {
            return Err(StoreError::Forbidden);
        }
    }
    Ok(())
}

async fn insert_team(
    connection: &mut PgConnection,
    actor: &Actor,
    input: &CreateTeam,
) -> Result<TeamSummary, StoreError> {
    let slug = slugify_team_name(&input.name);
    if slug.is_empty() {
        return Err(TeamError::EmptySlug.into());
    }
    let kind = serde_json::to_value(input.icon.kind).map_err(|_| StoreError::InvalidInput)?;
    let row=sqlx::query_as::<_,TeamRow>("INSERT INTO teams(workspace_id,slug,identifier,name,icon_kind,icon_value,color,timezone,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *")
        .bind(&actor.workspace_id).bind(slug).bind(&input.identifier).bind(&input.name).bind(kind.as_str()).bind(&input.icon.value).bind(&input.icon.color).bind(&input.timezone).bind(&actor.user_id).fetch_one(&mut *connection).await.map_err(|e|team_error(e,false))?;
    sqlx::query(
        "INSERT INTO team_members(workspace_id,team_id,user_id,role) VALUES($1,$2,$3,'member')",
    )
    .bind(&actor.workspace_id)
    .bind(row.id)
    .bind(&actor.user_id)
    .execute(connection)
    .await?;
    row.summary()
}

pub async fn create(
    database: &Database,
    actor: &Actor,
    input: &CreateTeam,
) -> Result<TeamSummary, StoreError> {
    let input =
        CreateTeam::parse(serde_json::to_value(input).map_err(|_| StoreError::InvalidInput)?)?;
    let mut tx = database.begin().await?;
    mutation_fence(&mut tx, &actor.workspace_id).await?;
    let live = current_actor(&mut tx, actor).await?;
    // First-party creation does not consume a command receipt, matching Forge.
    if !live.has_scope(ApiScope::TeamsWrite)
        || !security::settings(&mut tx, &live.workspace_id)
            .await?
            .allows(&live, SecurityAction::TeamsCreate)
    {
        return Err(StoreError::Forbidden);
    }
    tx.prepare().await?;
    let team = insert_team(&mut tx, &live, &input).await?;
    tx.commit().await?;
    Ok(team)
}

struct CreateCommand<'a> {
    input: &'a CreateTeam,
}
#[async_trait]
impl CommandHandler for CreateCommand<'_> {
    type Output = TeamSummary;
    async fn authorize(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
        value: Option<&TeamSummary>,
    ) -> Result<(), StoreError> {
        authorize_creation(connection, actor, value).await
    }
    async fn legacy(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
        command: &Command<'_>,
    ) -> Result<Option<TeamSummary>, StoreError> {
        let Authentication::ApiKey { credential_id } = &actor.authentication else {
            return Err(StoreError::Forbidden);
        };
        let prior:Option<(String,Option<String>,Option<i32>)>=sqlx::query_as("SELECT request_hash,response_body,response_status FROM api_idempotency_keys WHERE workspace_id=$1 AND credential_id=$2 AND operation_id=$3 AND idempotency_key=$4 FOR SHARE")
            .bind(&actor.workspace_id).bind(credential_id).bind(command.operation).bind(command.key).fetch_optional(connection).await?;
        let Some((hash, body, status)) = prior else {
            return Ok(None);
        };
        let legacy_hash = format!(
            "{:x}",
            Sha256::digest(forge_core::canonical::javascript_stringify(command.input).as_bytes())
        );
        if hash != legacy_hash {
            return Err(StoreError::CommandReused);
        }
        if body.is_none() || status.is_none() {
            return Err(StoreError::CommandAmbiguous);
        }
        let team = serde_json::from_str(body.as_deref().unwrap())
            .map_err(|_| StoreError::CommandResultUnavailable)?;
        Ok(Some(team))
    }
    async fn run(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
    ) -> Result<CommandResult<TeamSummary>, StoreError> {
        let team = insert_team(connection, actor, self.input).await?;
        Ok(CommandResult {
            resource_type: "team".into(),
            resource_id: team.id.to_string(),
            events: vec![OutboxEvent {
                topic: "teams.created.v1".into(),
                payload: serde_json::Map::from_iter([("teamId".into(), json!(team.id))]),
            }],
            value: team,
        })
    }
}
pub async fn create_idempotent(
    database: &Database,
    actor: &Actor,
    input: &CreateTeam,
    key: &str,
) -> Result<commands::Executed<TeamSummary>, StoreError> {
    if !matches!(actor.authentication, Authentication::ApiKey { .. }) {
        return Err(StoreError::Forbidden);
    }
    let input =
        CreateTeam::parse(serde_json::to_value(input).map_err(|_| StoreError::InvalidInput)?)?;
    let value = serde_json::to_value(&input).map_err(|_| StoreError::InvalidInput)?;
    commands::execute(
        database,
        actor,
        Command {
            key,
            operation: "createTeam",
            input: &value,
            status: 201,
        },
        &CreateCommand { input: &input },
    )
    .await
}

#[derive(Serialize, Deserialize)]
struct Cursor {
    id: Uuid,
    name: String,
}
pub async fn list(
    database: &Database,
    actor: &Actor,
    cursor: Option<&str>,
    limit: i64,
) -> Result<Value, StoreError> {
    let cursor = cursor
        .filter(|v| !v.is_empty())
        .map(|v| {
            URL_SAFE_NO_PAD
                .decode(v)
                .ok()
                .and_then(|v| serde_json::from_slice::<Cursor>(&v).ok())
                .ok_or(StoreError::InvalidInput)
        })
        .transpose()?;
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let live = current_actor(&mut tx, actor).await?;
    require_read(&live)?;
    let limit = limit.clamp(1, 100);
    let mut rows=sqlx::query_as::<_,TeamRow>("SELECT t.* FROM teams t WHERE t.workspace_id=$1 AND t.deleted_at IS NULL AND (t.visibility='workspace' OR $2 OR EXISTS(SELECT 1 FROM team_members tm WHERE tm.workspace_id=t.workspace_id AND tm.team_id=t.id AND tm.user_id=$3)) AND ($4::text IS NULL OR t.name>$4 OR (t.name=$4 AND t.id>$5)) ORDER BY t.name,t.id LIMIT $6")
        .bind(&live.workspace_id).bind(live.can_read_all_private_teams()).bind(&live.user_id).bind(cursor.as_ref().map(|c|&c.name)).bind(cursor.as_ref().map(|c|c.id)).bind(limit+1).fetch_all(&mut *tx).await?;
    let more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let cursor = if more {
        rows.last().map(|r| {
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&Cursor {
                    id: r.id,
                    name: r.name.clone(),
                })
                .expect("cursor JSON"),
            )
        })
    } else {
        None
    };
    let items: Vec<_> = rows
        .iter()
        .map(TeamRow::summary)
        .collect::<Result<_, _>>()?;
    tx.commit().await?;
    Ok(json!({"items":items,"nextCursor":cursor}))
}
pub async fn get(
    database: &Database,
    actor: &Actor,
    selector: &Selector,
) -> Result<Option<TeamSummary>, StoreError> {
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let live = current_actor(&mut tx, actor).await?;
    let value = get_in(&mut tx, &live, selector).await?;
    tx.commit().await?;
    Ok(value)
}

pub(crate) async fn get_in(
    connection: &mut PgConnection,
    actor: &Actor,
    selector: &Selector,
) -> Result<Option<TeamSummary>, StoreError> {
    require_read(actor)?;
    select_team(connection, actor, selector, false, false)
        .await?
        .map(|r| r.summary())
        .transpose()
}

pub(crate) async fn authorize_capability_update(
    connection: &mut PgConnection,
    actor: &Actor,
    selector: &Selector,
    before: bool,
) -> Result<(), StoreError> {
    require_read(actor)?;
    require_manage(actor)?;
    select_team(connection, actor, selector, false, before)
        .await?
        .ok_or(StoreError::Forbidden)?;
    Ok(())
}

pub async fn update(
    database: &Database,
    actor: &Actor,
    selector: &Selector,
    settings: &TeamSettings,
) -> Result<TeamSummary, StoreError> {
    let settings =
        TeamSettings::parse(serde_json::to_value(settings).map_err(|_| StoreError::InvalidInput)?)?;
    let mut tx = database.begin().await?;
    mutation_fence(&mut tx, &actor.workspace_id).await?;
    let live = current_actor(&mut tx, actor).await?;
    require_manage(&live)?;
    // Management authority can edit private teams independently of read scope.
    let row = managed_team(&mut tx, &live, selector, false)
        .await?
        .ok_or(TeamError::NotFound)?;
    tx.prepare().await?;
    let value = apply_settings(&mut tx, &row, &settings).await?;
    tx.commit().await?;
    Ok(value)
}

/// For prepared canonical commands: current authority and target were already
/// checked inside the same transaction by authorize_capability_update.
pub(crate) async fn update_in(
    connection: &mut PgConnection,
    actor: &Actor,
    selector: &Selector,
    settings: &TeamSettings,
) -> Result<TeamSummary, StoreError> {
    require_manage(actor)?;
    let row = managed_team(connection, actor, selector, false)
        .await?
        .ok_or(TeamError::NotFound)?;
    apply_settings(connection, &row, settings).await
}

async fn apply_settings(
    connection: &mut PgConnection,
    row: &TeamRow,
    settings: &TeamSettings,
) -> Result<TeamSummary, StoreError> {
    let icon = settings.icon.as_ref();
    let kind = icon.map(|i| serde_json::to_value(i.kind).expect("icon kind"));
    let scheme = settings
        .estimation_scheme
        .map(|s| serde_json::to_value(s).expect("scheme"));
    let updated=sqlx::query_as::<_,TeamRow>("UPDATE teams SET name=$1,identifier=$2,description=$3,timezone=$4,estimation_scheme=$5,issue_email_enabled=$6,detailed_history_enabled=$7,icon_kind=$8,icon_value=$9,color=$10,updated_at=clock_timestamp() WHERE id=$11 RETURNING *")
        .bind(settings.name.as_deref().unwrap_or(&row.name)).bind(settings.identifier.as_deref().unwrap_or(&row.identifier)).bind(settings.description.as_deref().unwrap_or(&row.description)).bind(settings.timezone.as_deref().unwrap_or(&row.timezone)).bind(scheme.as_ref().and_then(Value::as_str).unwrap_or(&row.estimation_scheme)).bind(settings.issue_email_enabled.unwrap_or(row.issue_email_enabled)).bind(settings.detailed_history_enabled.unwrap_or(row.detailed_history_enabled)).bind(kind.as_ref().and_then(Value::as_str).unwrap_or(&row.icon_kind)).bind(icon.map(|i|i.value.as_str()).unwrap_or(&row.icon_value)).bind(icon.map(|i|i.color.as_str()).unwrap_or(&row.color)).bind(row.id).fetch_one(connection).await.map_err(|e|team_error(e,false))?;
    updated.summary()
}
async fn managed_team(
    connection: &mut PgConnection,
    actor: &Actor,
    selector: &Selector,
    archived: bool,
) -> Result<Option<TeamRow>, StoreError> {
    Ok(sqlx::query_as::<_, TeamRow>(&format!(
        "SELECT t.* FROM teams t WHERE t.workspace_id=$1 AND {}=$2 AND {} FOR UPDATE",
        selector.column(),
        if archived {
            "t.deleted_at>clock_timestamp()-interval '30 days'"
        } else {
            "t.deleted_at IS NULL"
        }
    ))
    .bind(&actor.workspace_id)
    .bind(selector.value())
    .fetch_optional(connection)
    .await?)
}
pub async fn archive(
    database: &Database,
    actor: &Actor,
    selector: &Selector,
    confirmation: Option<&str>,
) -> Result<Value, StoreError> {
    let mut tx = database.begin().await?;
    mutation_fence(&mut tx, &actor.workspace_id).await?;
    let live = current_actor(&mut tx, actor).await?;
    require_manage(&live)?;
    let row = managed_team(&mut tx, &live, selector, false)
        .await?
        .filter(|r| confirmation.is_none_or(|name| name == r.name))
        .ok_or(TeamError::ConfirmationMismatch)?;
    tx.prepare().await?;
    let deleted:DateTime<Utc>=sqlx::query_scalar("UPDATE teams SET deleted_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING deleted_at").bind(row.id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(
        json!({"team":{"name":row.name,"slug":row.slug},"recoverableUntil":deleted+chrono::Duration::days(RECOVERY_DAYS)}),
    )
}
pub async fn restore(
    database: &Database,
    actor: &Actor,
    selector: &Selector,
) -> Result<TeamSummary, StoreError> {
    let mut tx = database.begin().await?;
    mutation_fence(&mut tx, &actor.workspace_id).await?;
    let live = current_actor(&mut tx, actor).await?;
    require_manage(&live)?;
    let row = managed_team(&mut tx, &live, selector, true)
        .await?
        .ok_or(TeamError::NotFound)?;
    tx.prepare().await?;
    let restored = sqlx::query_as::<_, TeamRow>(
        "UPDATE teams SET deleted_at=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
    )
    .bind(row.id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| team_error(e, true))?;
    tx.commit().await?;
    restored.summary()
}

pub async fn join(
    database: &Database,
    actor: &Actor,
    selector: &Selector,
    leaving: bool,
) -> Result<Value, StoreError> {
    let mut tx = database.begin().await?;
    mutation_fence(&mut tx, &actor.workspace_id).await?;
    let live = current_actor(&mut tx, actor).await?;
    require_read(&live)?;
    if !live.has_scope(ApiScope::TeamsWrite) {
        return Err(StoreError::Forbidden);
    }
    let team = select_team(&mut tx, &live, selector, false, true)
        .await?
        .ok_or(TeamError::NotFound)?;
    let role:Option<String>=sqlx::query_scalar("SELECT role FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3 FOR UPDATE").bind(&live.workspace_id).bind(team.id).bind(&live.user_id).fetch_optional(&mut *tx).await?;
    if leaving {
        let role = role.ok_or(TeamError::NotMember)?;
        if role == "lead" {
            let count:i64=sqlx::query_scalar("SELECT count(*) FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND role='lead'").bind(&live.workspace_id).bind(team.id).fetch_one(&mut *tx).await?;
            if count <= 1 {
                return Err(TeamError::LastLead.into());
            }
        }
        tx.prepare().await?;
        sqlx::query("DELETE FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3")
            .bind(&live.workspace_id)
            .bind(team.id)
            .bind(&live.user_id)
            .execute(&mut *tx)
            .await?;
    } else if role.is_none() {
        if team.visibility == "private" && !live.can_manage_teams() {
            return Err(StoreError::Forbidden);
        }
        sqlx::query("INSERT INTO team_members(workspace_id,team_id,user_id,role) VALUES($1,$2,$3,'member') ON CONFLICT(team_id,user_id) DO NOTHING").bind(&live.workspace_id).bind(team.id).bind(&live.user_id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(json!({"team":{"name":team.name,"slug":team.slug}}))
}

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryMember {
    user_id: String,
    name: String,
    email: String,
    image: Option<String>,
    username: Option<String>,
    workspace_role: String,
    team_role: Option<String>,
    team_joined_at: Option<DateTime<Utc>>,
}
async fn member_rows(
    connection: &mut PgConnection,
    actor: &Actor,
    team: Uuid,
) -> Result<Vec<DirectoryMember>, StoreError> {
    Ok(sqlx::query_as("SELECT u.id user_id,u.name,u.email,u.image,u.username,m.role workspace_role,tm.role team_role,tm.created_at team_joined_at FROM member m JOIN \"user\" u ON u.id=m.user_id LEFT JOIN team_members tm ON tm.workspace_id=m.organization_id AND tm.team_id=$1 AND tm.user_id=m.user_id WHERE m.organization_id=$2 ORDER BY m.created_at,m.id")
        .bind(team).bind(&actor.workspace_id).fetch_all(connection).await?)
}
pub async fn member_directory(
    database: &Database,
    actor: &Actor,
    selector: &Selector,
) -> Result<Value, StoreError> {
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let live = current_actor(&mut tx, actor).await?;
    require_read(&live)?;
    let team = select_team(&mut tx, &live, selector, false, false)
        .await?
        .ok_or(StoreError::Forbidden)?;
    let can_manage = live.can_manage_teams();
    let rows = member_rows(&mut tx, &live, team.id).await?;
    let mut members = Vec::new();
    let mut available = Vec::new();
    for row in rows {
        let joined = row.team_role.is_some();
        let mut value = serde_json::to_value(row).map_err(|_| StoreError::InvalidInput)?;
        value.as_object_mut().unwrap().remove("teamJoinedAt");
        if joined {
            members.push(value);
        } else if can_manage {
            available.push(value);
        }
    }
    tx.commit().await?;
    Ok(json!({"canManage":can_manage,"members":members,"availableMembers":available}))
}
pub async fn add_members(
    database: &Database,
    actor: &Actor,
    selector: &Selector,
    user_ids: &[String],
) -> Result<(), StoreError> {
    if user_ids.is_empty() || user_ids.len() > 100 || user_ids.iter().any(String::is_empty) {
        return Err(StoreError::InvalidInput);
    }
    let mut tx = database.begin().await?;
    mutation_fence(&mut tx, &actor.workspace_id).await?;
    let live = current_actor(&mut tx, actor).await?;
    require_read(&live)?;
    require_manage(&live)?;
    let team = select_team(&mut tx, &live, selector, false, true)
        .await?
        .ok_or(StoreError::Forbidden)?;
    let mut ids = user_ids.to_vec();
    ids.sort();
    ids.dedup();
    let eligible:Vec<String>=sqlx::query_scalar("SELECT user_id FROM member WHERE organization_id=$1 AND user_id=ANY($2) ORDER BY user_id FOR SHARE").bind(&live.workspace_id).bind(&ids).fetch_all(&mut *tx).await?;
    if eligible != ids {
        return Err(StoreError::InvalidInput);
    }
    for user in ids {
        sqlx::query("INSERT INTO team_members(workspace_id,team_id,user_id,role) VALUES($1,$2,$3,'member') ON CONFLICT(team_id,user_id) DO NOTHING").bind(&live.workspace_id).bind(team.id).bind(user).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}
fn directory_person(member: &DirectoryMember) -> Value {
    let username = member.username.clone().unwrap_or_else(|| {
        member
            .email
            .split('@')
            .next()
            .unwrap_or("")
            .to_lowercase()
            .chars()
            .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-'))
            .take(32)
            .collect()
    });
    json!({"id":member.user_id,"name":member.name,"username":username,"image":member.image})
}
pub async fn directory(
    database: &Database,
    actor: &Actor,
    archived: bool,
) -> Result<Value, StoreError> {
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let live = current_actor(&mut tx, actor).await?;
    let result = directory_in(&mut tx, &live, archived).await?;
    tx.commit().await?;
    Ok(result)
}

pub(crate) async fn directory_in(
    connection: &mut PgConnection,
    live: &Actor,
    archived: bool,
) -> Result<Value, StoreError> {
    require_read(live)?;
    let rows=sqlx::query_as::<_,TeamRow>(&format!("SELECT t.* FROM teams t WHERE t.workspace_id=$1 AND {} AND (t.visibility='workspace' OR $2 OR EXISTS(SELECT 1 FROM team_members tm WHERE tm.workspace_id=t.workspace_id AND tm.team_id=t.id AND tm.user_id=$3)) ORDER BY t.name,t.id",if archived{"t.deleted_at>clock_timestamp()-interval '30 days'"}else{"t.deleted_at IS NULL"}))
        .bind(&live.workspace_id).bind(live.can_read_all_private_teams()).bind(&live.user_id).fetch_all(&mut *connection).await?;
    let can_manage = live.can_manage_teams();
    let can_create = live.has_scope(ApiScope::TeamsWrite)
        && security::settings(&mut *connection, &live.workspace_id)
            .await?
            .allows(live, SecurityAction::TeamsCreate);
    #[derive(FromRow)]
    struct BatchMember {
        team_id: Uuid,
        #[sqlx(flatten)]
        member: DirectoryMember,
    }
    let ids: Vec<_> = rows.iter().map(|r| r.id).collect();
    let memberships=sqlx::query_as::<_,BatchMember>("SELECT tm.team_id,u.id user_id,u.name,u.email,u.image,u.username,m.role workspace_role,tm.role team_role,tm.created_at team_joined_at FROM team_members tm JOIN member m ON m.organization_id=tm.workspace_id AND m.user_id=tm.user_id JOIN \"user\" u ON u.id=tm.user_id WHERE tm.workspace_id=$1 AND tm.team_id=ANY($2) ORDER BY m.created_at,m.id")
        .bind(&live.workspace_id).bind(ids).fetch_all(&mut *connection).await?;
    let mut by_team = std::collections::HashMap::<Uuid, Vec<DirectoryMember>>::new();
    for membership in memberships {
        by_team
            .entry(membership.team_id)
            .or_default()
            .push(membership.member);
    }
    let mut items = Vec::new();
    for row in rows {
        let members = by_team.remove(&row.id).unwrap_or_default();
        let mut members: Vec<_> = members.iter().filter(|m| m.team_role.is_some()).collect();
        let membership = members.iter().find(|m| m.user_id == live.user_id);
        let lead_count = members
            .iter()
            .filter(|m| m.team_role.as_deref() == Some("lead"))
            .count();
        let is_member = membership.is_some();
        let can_leave = !archived
            && membership.is_some_and(|m| m.team_role.as_deref() != Some("lead") || lead_count > 1);
        let people: Vec<_> = members.iter().map(|m| directory_person(m)).collect();
        let owners: Vec<_> = members
            .iter()
            .filter(|m| m.team_role.as_deref() == Some("lead"))
            .map(|m| directory_person(m))
            .collect();
        members.sort_by_key(|m| m.team_joined_at);
        let previews: Vec<_> = members
            .iter()
            .take(5)
            .map(|m| directory_person(m))
            .collect();
        let until = row
            .deleted_at
            .map(|at| at + chrono::Duration::days(RECOVERY_DAYS));
        let mut value =
            serde_json::to_value(row.summary()?).map_err(|_| StoreError::InvalidInput)?;
        for (key,value_field) in json!({"lifecycle":if archived{"archived"}else{"active"},"isMember":is_member,"memberCount":members.len(),"directoryMembers":people,"owners":owners,"updatedAt":row.updated_at,"memberPreviews":previews,"issueCount":null,"recoverableUntil":until,"capabilities":{"canOpenSettings":!archived,"canLeave":can_leave,"canDelete":!archived&&can_manage,"canRestore":archived&&can_manage&&until.is_some_and(|at|at>Utc::now())}}).as_object().unwrap(){value[key]=value_field.clone();}
        items.push(value);
    }
    Ok(json!({"items":items,"canCreateTeam":can_create}))
}

fn team_error(error: sqlx::Error, restoring: bool) -> StoreError {
    let constraint = error.as_database_error().and_then(|e| e.constraint());
    match constraint {
        Some("workspace_team_limit") => TeamError::TeamLimit.into(),
        Some("teams_workspace_slug_unique" | "teams_workspace_identifier_unique") if restoring => {
            TeamError::RestoreConflict.into()
        }
        Some("teams_workspace_slug_unique") => TeamError::SlugTaken.into(),
        Some("teams_workspace_identifier_unique") => TeamError::IdentifierTaken.into(),
        _ => error.into(),
    }
}
