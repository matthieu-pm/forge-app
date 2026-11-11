//! Owner-scoped serialized state and retained, never implicitly replayed, drafts.
use crate::{
    Database, StoreError,
    authority::current_actor,
    commands::{self, Command, CommandHandler, CommandResult},
    documents,
    initiatives::{self, InitiativeOptions},
    issues, projects, resource_policy as policy,
    workspaces::lock_workspace,
};
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use forge_core::{
    actor::{Actor, Authentication},
    features::{FeatureMode, FeatureRollouts},
    product_state as contract,
    product_state::copies,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection};
use std::collections::HashSet;
use uuid::Uuid;
fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}
fn parse(raw: &str) -> Result<Value, StoreError> {
    forge_core::json::parse(raw).map_err(|_| StoreError::InvalidInput)
}
fn session(a: &Actor) -> Result<(), StoreError> {
    if matches!(a.authentication, Authentication::Session { .. }) {
        Ok(())
    } else {
        Err(StoreError::Forbidden)
    }
}
fn feature(a: &Actor, key: &str) -> Result<(), StoreError> {
    if let Some(feature) = contract::feature(key) {
        let raw = std::env::var("FORGE_FEATURE_ROLLOUTS").ok();
        let rollouts = FeatureRollouts::parse(raw.as_deref()).unwrap_or_default();
        if rollouts.mode(feature, &a.workspace_id, false) != FeatureMode::Enabled {
            return Err(StoreError::Forbidden);
        }
    }
    Ok(())
}
async fn scope(
    c: &mut PgConnection,
    a: &Actor,
    key: &str,
    write: bool,
) -> Result<String, StoreError> {
    if !contract::product_key(key) {
        return Err(StoreError::Forbidden);
    }
    feature(a, key)?;
    if contract::workspace_key(key).is_some_and(|w| w != a.workspace_id) {
        return Err(StoreError::Forbidden);
    }
    if let Some(team) = contract::team_key(key) {
        let team = team.parse().map_err(|_| StoreError::InvalidInput)?;
        policy::team(c, a, team).await?;
        sqlx::query("SELECT id FROM team_members WHERE workspace_id=$1 AND team_id=$2 AND user_id=$3 FOR SHARE").bind(&a.workspace_id).bind(team).bind(&a.user_id).fetch_optional(&mut *c).await?;
        // A role/membership change may have committed while the source row waited.
        policy::team(c, a, team).await?;
    }
    if let Some(project) = contract::post_project(key) {
        let q = format!(
            "SELECT p.id FROM projects p WHERE p.id=$4 AND {}",
            policy::readable_project("p.id")
        );
        sqlx::query(&q)
            .bind(&a.workspace_id)
            .bind(policy::privileged(a))
            .bind(&a.user_id)
            .bind(
                project
                    .parse::<Uuid>()
                    .map_err(|_| StoreError::InvalidInput)?,
            )
            .fetch_optional(&mut *c)
            .await?
            .ok_or(StoreError::Forbidden)?;
    }
    if write && key == contract::shared_initiatives(&a.workspace_id) {
        return Err(StoreError::Forbidden);
    }
    let shared = contract::shared(key, &a.workspace_id);
    if write && shared && !policy::privileged(a) {
        return Err(StoreError::Forbidden);
    }
    Ok(if shared {
        "workspace".into()
    } else {
        format!("user:{}", a.user_id)
    })
}
async fn fence(c: &mut PgConnection, a: &Actor) -> Result<(), StoreError> {
    sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
        .bind(&a.workspace_id)
        .fetch_one(c)
        .await?;
    Ok(())
}
#[derive(FromRow)]
struct Row {
    id: Uuid,
    key: String,
    owner_id: String,
    encoded_value: Option<String>,
    revision: i32,
}
fn decode(encoded: Option<&str>) -> Result<Option<String>, StoreError> {
    encoded
        .map(|s| serde_json::from_str(s).map_err(|_| StoreError::InvalidInput))
        .transpose()
}
async fn issue_value(
    c: &mut PgConnection,
    a: &Actor,
    key: &str,
    value: Option<&str>,
    previous: Option<Option<&str>>,
) -> Result<Option<String>, StoreError> {
    if value.is_none() || !copies::issue_key(key) {
        return Ok(value.map(str::to_owned));
    }
    let mut ids = copies::issue_ids(key, value).map_err(|_| StoreError::InvalidInput)?;
    if let Some(Some(raw)) = previous
        && let Ok(prior) = copies::issue_ids(key, Some(raw))
    {
        ids.extend(prior);
    }
    let ids: Vec<Uuid> = ids
        .into_iter()
        .collect::<HashSet<_>>()
        .into_iter()
        .map(|id| id.parse().map_err(|_| StoreError::InvalidInput))
        .collect::<Result<_, _>>()?;
    type Issue = (
        Uuid,
        Option<DateTime<Utc>>,
        Option<DateTime<Utc>>,
        Option<DateTime<Utc>>,
    );
    let q = format!(
        "SELECT i.id,i.deleted_at,i.archived_at,i.purge_started_at FROM issues i WHERE i.id=ANY($4) AND {}",
        policy::retained_issue("i.id")
    );
    let rows: Vec<Issue> = sqlx::query_as(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(a))
        .bind(&a.user_id)
        .bind(ids)
        .fetch_all(c)
        .await?;
    let visible: HashSet<String> = rows
        .iter()
        .filter(|r| r.1.is_none() && r.2.is_none())
        .map(|r| r.0.to_string())
        .collect();
    let projected = copies::filter_issue(
        key,
        value,
        &mut |id| visible.contains(id),
        0,
        if previous.is_none() {
            copies::Mode::Read
        } else {
            copies::Mode::Scrub
        },
    )
    .map_err(|_| StoreError::InvalidInput)?;
    let Some(previous) = previous else {
        return Ok(projected);
    };
    let now = Utc::now();
    let retained: HashSet<String> = rows
        .iter()
        .filter(|r| {
            !visible.contains(&r.0.to_string())
                && r.3.is_none()
                && r.1
                    .is_none_or(|deleted| deleted + Duration::hours(720) > now)
        })
        .map(|r| r.0.to_string())
        .collect();
    let prior = previous.or(value);
    if copies::retained_command(key, prior, &retained, 0).map_err(|_| StoreError::InvalidInput)? {
        if let (Some(before), Some(next)) = (previous.filter(|s| !s.is_empty()), value)
            && forge_core::canonical::javascript_stringify(&parse(before)?)
                != forge_core::canonical::javascript_stringify(&parse(next)?)
        {
            return Err(StoreError::Planning(
                "Restore or explicitly discard the saved batch containing an unavailable issue before replacing it.",
            ));
        }
        return Ok(prior.map(str::to_owned));
    }
    copies::retain_hidden(key, projected.as_deref(), prior, &retained, 0)
        .map_err(|_| StoreError::InvalidInput)
}
pub async fn read(
    db: &Database,
    a: &Actor,
    options: InitiativeOptions,
) -> Result<Value, StoreError> {
    session(a)?;
    let mut tx = db.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await?;
    lock_workspace(&mut tx, &a.workspace_id, false).await?;
    let a = current_actor(&mut tx, a).await?;
    let rows:Vec<Row>=sqlx::query_as("SELECT id,key,owner_id,encoded_value,revision FROM product_state WHERE workspace_id=$1 AND owner_id IN('workspace',$2)").bind(&a.workspace_id).bind(format!("user:{}",a.user_id)).fetch_all(&mut *tx).await?;
    let q = format!(
        "SELECT p.id,p.properties->'labelIds' FROM projects p WHERE {}",
        policy::readable_project("p.id")
    );
    let projects: Vec<(Uuid, Option<Value>)> = sqlx::query_as(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(&a))
        .bind(&a.user_id)
        .fetch_all(&mut *tx)
        .await?;
    let visible: HashSet<String> = projects.iter().map(|p| p.0.to_string()).collect();
    let mut entries = vec![];
    for row in rows {
        let projected = async {
            if scope(&mut tx, &a, &row.key, false).await? != row.owner_id {
                return Err(StoreError::Forbidden);
            }
            let original = decode(row.encoded_value.as_deref())?;
            copies::project_ids(&row.key, original.as_deref())
                .map_err(|_| StoreError::InvalidInput)?;
            let value = copies::filter_project(
                &row.key,
                original.as_deref(),
                &mut |id| visible.contains(id),
                0,
            )
            .map_err(|_| StoreError::InvalidInput)?;
            let value = issue_value(&mut tx, &a, &row.key, value.as_deref(), None).await?;
            let mut projected =
                documents::prune_team_copies(&mut tx, &a, &row.key, value.as_deref(), None).await?;
            if row.key == "forge:workspace-project-labels:v1"
                && let Some(raw) = value.as_deref().filter(|s| !s.is_empty())
            {
                let mut directory = parse(raw)?;
                directory["catalogRevision"] = json!(row.revision);
                directory["inheritedCount"] = json!(0);
                for key in ["labels", "groups"] {
                    for label in directory[key]
                        .as_array_mut()
                        .ok_or(StoreError::InvalidInput)?
                    {
                        label["issues"] = json!(
                            projects
                                .iter()
                                .filter(|p| p
                                    .1
                                    .as_ref()
                                    .and_then(Value::as_array)
                                    .is_some_and(|ids| ids.contains(&label["id"])))
                                .count()
                        );
                        label["lastApplied"] = Value::Null;
                    }
                }
                projected = Some(forge_core::canonical::javascript_stringify(&directory));
            }
            Ok::<_, StoreError>(json!({"key":row.key,"value":projected,"revision":row.revision}))
        }
        .await;
        if let Ok(entry) = projected {
            entries.push(entry);
        }
    }
    for (key, value) in [
        (
            format!("forge:project-statuses:v1:{}", a.workspace_id),
            forge_core::projects::initial_statuses(),
        ),
        (
            "forge:workspace-project-labels:v1".into(),
            json!({"version":1,"labels":[],"groups":[],"inheritedCount":0,"catalogRevision":0}),
        ),
    ] {
        if !entries.iter().any(|e| e["key"] == key) {
            entries.push(json!({"key":key,"value":forge_core::canonical::javascript_stringify(&value),"revision":0}));
        }
    }
    entries.push(json!({"key":contract::shared_initiatives(&a.workspace_id),"value":forge_core::canonical::javascript_stringify(&initiatives::snapshot(&mut tx,&a,options).await?),"revision":0}));
    let settings = initiatives::settings(&mut tx, &a, options).await?;
    let key = contract::initiative_settings(&a.workspace_id);
    let value = json!(forge_core::canonical::javascript_stringify(
        &settings["settings"]
    ));
    if let Some(entry) = entries.iter_mut().find(|e| e["key"] == key) {
        entry["value"] = value;
    } else {
        entries.push(json!({"key":key,"value":value,"revision":0}));
    }
    let q = format!(
        "SELECT t.id FROM teams t WHERE {}",
        policy::readable_team("t.id")
    );
    let team_ids: Vec<Uuid> = sqlx::query_scalar(&q)
        .bind(&a.workspace_id)
        .bind(policy::privileged(&a))
        .bind(&a.user_id)
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(
        json!({"workspaceId":a.workspace_id,"userId":a.user_id,"workspaceRole":a.workspace_role,"sessionId":match &a.authentication{Authentication::Session{session_id}=>session_id.as_str(),_=>""},"initiativeFeatureAvailable":options.enabled,"entries":entries,"teamIds":team_ids}),
    )
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    revision: i32,
}
struct Save<'a> {
    input: &'a Value,
}
#[async_trait]
impl CommandHandler for Save<'_> {
    type Output = Saved;
    async fn authorize(
        &self,
        c: &mut PgConnection,
        a: &Actor,
        _: Option<&Saved>,
    ) -> Result<(), StoreError> {
        session(a)?;
        scope(c, a, text(self.input, "key"), true).await?;
        Ok(())
    }
    async fn run(
        &self,
        c: &mut PgConnection,
        a: &Actor,
    ) -> Result<CommandResult<Saved>, StoreError> {
        let key = text(self.input, "key");
        let owner = scope(c, a, key, true).await?;
        if copies::issue_key(key) {
            fence(c, a).await?;
        }
        let team = contract::team_key(key)
            .map(|id| id.parse::<Uuid>().map_err(|_| StoreError::InvalidInput))
            .transpose()?;
        sqlx::query("INSERT INTO product_state(workspace_id,owner_id,owner_user_id,team_id,key,encoded_value) VALUES($1,$2,$3,$4,$5,NULL) ON CONFLICT DO NOTHING").bind(&a.workspace_id).bind(&owner).bind(if owner=="workspace"{None}else{Some(a.user_id.as_str())}).bind(team).bind(key).execute(&mut *c).await?;
        let row:Row=sqlx::query_as("SELECT id,key,owner_id,encoded_value,revision FROM product_state WHERE workspace_id=$1 AND owner_id=$2 AND key=$3 FOR UPDATE").bind(&a.workspace_id).bind(owner).bind(key).fetch_one(&mut *c).await?;
        let value = self.input["value"].as_str();
        let old = decode(row.encoded_value.as_deref())?;
        if contract::capture(key, r"^forge:file-draft:v1:[0-9a-f-]{36}:creation$").is_some()
            && value.is_some()
            && row.encoded_value.is_none()
        {
            return Err(StoreError::Forbidden);
        }
        if self.input["expectedRevision"] != row.revision {
            if old.as_deref() == value {
                return Ok(CommandResult {
                    value: Saved {
                        revision: row.revision,
                    },
                    resource_type: "productState".into(),
                    resource_id: row.id.to_string(),
                    events: vec![],
                });
            }
            return Err(StoreError::Planning(
                "This data changed in another session. Your pending changes are preserved in this session; reload the latest version before retrying.",
            ));
        }
        let projected = issue_value(c, a, key, value, Some(old.as_deref())).await?;
        let value =
            documents::prune_team_copies(c, a, key, projected.as_deref(), old.as_deref()).await?;
        let revision = row
            .revision
            .checked_add(1)
            .ok_or(StoreError::InvalidInput)?;
        let encoded = value
            .map(|s| serde_json::to_string(&s).map_err(|_| StoreError::InvalidInput))
            .transpose()?;
        sqlx::query("UPDATE product_state SET encoded_value=$1,revision=$2 WHERE id=$3")
            .bind(encoded)
            .bind(revision)
            .bind(row.id)
            .execute(c)
            .await?;
        Ok(CommandResult {
            value: Saved { revision },
            resource_type: "productState".into(),
            resource_id: row.id.to_string(),
            events: vec![],
        })
    }
}
pub async fn save(
    db: &Database,
    a: &Actor,
    input: Value,
    options: InitiativeOptions,
) -> Result<Value, StoreError> {
    let input = contract::command(input).map_err(|_| StoreError::InvalidInput)?;
    session(a)?;
    if input["workspaceId"] != a.workspace_id
        || !matches!(&a.authentication,Authentication::Session{session_id} if input["sessionId"]==*session_id)
    {
        return Err(StoreError::Forbidden);
    }
    let key = text(&input, "key");
    if key == contract::shared_initiatives(&a.workspace_id) {
        return Err(StoreError::Forbidden);
    }
    feature(a, key)?;
    for (prefix, initiative) in [
        (contract::INITIATIVE_COMMAND, true),
        (contract::PROJECT_COMMAND, false),
    ] {
        if key.starts_with(prefix) {
            let raw = input["value"].as_str().ok_or(StoreError::Forbidden)?;
            return if initiative {
                initiatives::save(db, a, text(&input, "commandKey"), parse(raw)?, options).await
            } else {
                projects::save(db, a, text(&input, "commandKey"), parse(raw)?).await
            };
        }
    }
    let common = json!({"commandKey":input["commandKey"],"value":input["value"],"expectedRevision":input["expectedRevision"]});
    if let Some(kind) = contract::catalog_kind(key, &a.workspace_id) {
        let mut command = common;
        command["kind"] = json!(kind);
        return projects::save_catalog(db, a, command).await;
    }
    if key == contract::initiative_settings(&a.workspace_id) {
        return initiatives::save_settings(db, a, common).await;
    }
    if let Some(team) = contract::capture(key, r"^forge:team-(?:cycles|triage):v1:([0-9a-f-]{36})$")
    {
        let mut command = common;
        command["teamId"] = json!(team);
        command["kind"] = json!(if key.starts_with("forge:team-cycles:") {
            "cycles"
        } else {
            "triage"
        });
        return issues::save_team_settings(db, a, command).await;
    }
    if let Some(raw) = input["value"].as_str() {
        if key.starts_with("forge:team-cycles:v1:") {
            forge_core::cycles::Settings::parse(parse(raw)?)
                .map_err(|_| StoreError::InvalidInput)?;
        }
        if key.starts_with("forge:team-triage:v1:") {
            forge_core::cycles::triage(parse(raw)?).map_err(|_| StoreError::InvalidInput)?;
        }
        if key.starts_with("forge:team-project-updates:v1:") {
            let value = parse(raw)?;
            if value["guidance"]
                .as_str()
                .is_none_or(|s| forge_core::text::length(s) > 50_000)
            {
                return Err(StoreError::InvalidInput);
            }
        }
        if key.starts_with("forge:team-thread-summaries:v1:") && !["true", "false"].contains(&raw) {
            return Err(StoreError::InvalidInput);
        }
    }
    let payload = json!({"workspaceId":input["workspaceId"],"key":input["key"],"value":input["value"],"expectedRevision":input["expectedRevision"]});
    let result = commands::execute(
        db,
        a,
        Command {
            key: text(&input, "commandKey"),
            operation: "productState.save@1",
            input: &payload,
            status: 200,
        },
        &Save { input: &input },
    )
    .await?;
    Ok(json!({"value":result.value,"replayed":result.replayed}))
}
