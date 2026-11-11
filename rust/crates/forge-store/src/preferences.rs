//! Owner-only preferences with independent field versions and fresh retry snapshots.
use crate::{
    Database, StoreError,
    authority::current_actor,
    commands::{self, Command, CommandHandler, CommandResult},
};
use async_trait::async_trait;
use forge_core::{
    actor::{Actor, ApiScope, Authentication},
    features::{FeatureMode, FeatureRollouts, ProductFeature},
    preferences as contract,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection};
pub mod imports;
#[derive(Clone, Copy, Default)]
pub struct PreferenceOptions {
    pub enabled: bool,
    pub names: bool,
    pub import_enabled: bool,
    pub agent_guidance: bool,
}
impl PreferenceOptions {
    pub fn from_env(a: &Actor) -> Self {
        let rollouts =
            FeatureRollouts::parse(std::env::var("FORGE_FEATURE_ROLLOUTS").ok().as_deref())
                .unwrap_or_default();
        let enabled = |f| rollouts.mode(f, &a.workspace_id, false) == FeatureMode::Enabled;
        Self {
            enabled: std::env::var("FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED").as_deref()
                == Ok("true"),
            names: std::env::var("FORGE_PERSON_NAME_FORMATTING_ENABLED").as_deref() == Ok("true"),
            import_enabled: enabled(ProductFeature::PersonalPreferenceImport),
            agent_guidance: enabled(ProductFeature::AgentGuidance),
        }
    }
}
fn sync(options: PreferenceOptions) -> Result<(), StoreError> {
    if options.enabled {
        Ok(())
    } else {
        Err(StoreError::Planning(
            "Personal preference synchronization is unavailable.",
        ))
    }
}
fn session(a: &Actor, id: Option<&str>) -> Result<(), StoreError> {
    if matches!(&a.authentication,Authentication::Session{session_id} if id.is_none_or(|id|id==session_id))
    {
        Ok(())
    } else {
        Err(StoreError::Forbidden)
    }
}
#[derive(FromRow)]
struct Row {
    version: i32,
    revision: i32,
    values: Value,
    field_versions: Value,
}
fn table(scope: &str) -> Result<(&'static str, &'static str), StoreError> {
    match scope {
        "account" => Ok(("account_preferences", "user_id=$1")),
        "workspace" => Ok(("workspace_preferences", "user_id=$1 AND workspace_id=$2")),
        _ => Err(StoreError::InvalidInput),
    }
}
async fn row(
    c: &mut PgConnection,
    a: &Actor,
    scope: &str,
    lock: bool,
) -> Result<Option<Row>, StoreError> {
    let (t, p) = table(scope)?;
    if lock {
        let insert = if scope == "workspace" {
            format!("INSERT INTO {t}(user_id,workspace_id) VALUES($1,$2) ON CONFLICT DO NOTHING")
        } else {
            format!("INSERT INTO {t}(user_id) VALUES($1) ON CONFLICT DO NOTHING")
        };
        let q = sqlx::query(&insert).bind(&a.user_id);
        if scope == "workspace" {
            q.bind(&a.workspace_id).execute(&mut *c).await?;
        } else {
            q.execute(&mut *c).await?;
        }
    }
    let sql = format!(
        "SELECT version,revision,values,field_versions FROM {t} WHERE {p} {}",
        if lock { "FOR UPDATE" } else { "" }
    );
    let q = sqlx::query_as(&sql).bind(&a.user_id);
    Ok(if scope == "workspace" {
        q.bind(&a.workspace_id).fetch_optional(c).await?
    } else {
        q.fetch_optional(c).await?
    })
}
fn field_version(value: Option<&Value>) -> Option<f64> {
    match value.filter(|v| !v.is_null()) {
        None => Some(0.0),
        Some(v) => v.as_f64(),
    }
}
async fn write(c: &mut PgConnection, a: &Actor, scope: &str, row: &Row) -> Result<(), StoreError> {
    let (t, p) = table(scope)?;
    let offset = if scope == "workspace" { 3 } else { 2 };
    let sql = format!(
        "UPDATE {t} SET values=${offset},field_versions=${},revision=${} WHERE {p}",
        offset + 1,
        offset + 2
    );
    let mut q = sqlx::query(&sql).bind(&a.user_id);
    if scope == "workspace" {
        q = q.bind(&a.workspace_id)
    }
    q.bind(&row.values)
        .bind(&row.field_versions)
        .bind(row.revision)
        .execute(c)
        .await?;
    Ok(())
}
pub async fn read(
    db: &Database,
    a: &Actor,
    scope: &str,
    options: PreferenceOptions,
) -> Result<Value, StoreError> {
    sync(options)?;
    session(a, None)?;
    let mut tx = db.begin().await?;
    let a = current_actor(&mut tx, a).await?;
    let found = row(&mut tx, &a, scope, false).await?;
    let mut v=found.map_or_else(||contract::empty(&a.user_id),|r|json!({"version":r.version,"revision":r.revision,"userId":a.user_id,"values":r.values,"fieldVersions":r.field_versions}));
    if scope == "workspace" {
        v["workspaceId"] = json!(a.workspace_id)
    }
    let v = contract::snapshot(v).map_err(|_| StoreError::InvalidInput)?;
    tx.commit().await?;
    Ok(v)
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Saved {
    user_id: String,
    revision: i32,
}
struct Patch<'a> {
    input: &'a Value,
    scope: &'a str,
}
#[async_trait]
impl CommandHandler for Patch<'_> {
    type Output = Saved;
    async fn authorize(
        &self,
        _: &mut PgConnection,
        a: &Actor,
        value: Option<&Saved>,
    ) -> Result<(), StoreError> {
        session(a, None)?;
        if value.is_some_and(|v| v.user_id != a.user_id) {
            return Err(StoreError::Forbidden);
        }
        Ok(())
    }
    async fn run(
        &self,
        c: &mut PgConnection,
        a: &Actor,
    ) -> Result<CommandResult<Saved>, StoreError> {
        let mut row = row(c, a, self.scope, true)
            .await?
            .ok_or(StoreError::InvalidInput)?;
        if row.version != 1 {
            return Err(StoreError::Planning(
                "Preferences require a newer version of Forge.",
            ));
        }
        let patch = self.input["patch"].as_object().unwrap();
        let conflicts: Vec<String> = patch
            .keys()
            .filter(|k| {
                field_version(row.field_versions.get(*k))
                    != self.input["expectedVersions"][*k].as_f64()
            })
            .cloned()
            .collect();
        if !conflicts.is_empty() {
            return Err(StoreError::PreferenceConflict(conflicts));
        }
        row.revision = row
            .revision
            .checked_add(1)
            .ok_or(StoreError::InvalidInput)?;
        for (k, v) in patch {
            row.values[k] = contract::field(self.scope, k, v.clone(), false)
                .map_err(|_| StoreError::InvalidInput)?;
            row.field_versions[k] = json!(row.revision)
        }
        write(c, a, self.scope, &row).await?;
        Ok(CommandResult {
            value: Saved {
                user_id: a.user_id.clone(),
                revision: row.revision,
            },
            resource_type: format!("{}Preferences", self.scope),
            resource_id: a.user_id.clone(),
            events: vec![],
        })
    }
}
pub async fn patch(
    db: &Database,
    a: &Actor,
    input: Value,
    options: PreferenceOptions,
) -> Result<Value, StoreError> {
    sync(options)?;
    let input = contract::command(input).map_err(|_| StoreError::InvalidInput)?;
    session(a, input["sessionId"].as_str())?;
    if input
        .get("expectedWorkspaceId")
        .is_some_and(|w| w != &a.workspace_id)
    {
        return Err(StoreError::Forbidden);
    }
    let scope = input["scope"].as_str().unwrap_or("account");
    let gated: Vec<_> = input["patch"]
        .as_object()
        .unwrap()
        .keys()
        .filter(|k| k.starts_with("agent."))
        .cloned()
        .collect();
    if !gated.is_empty() && !options.agent_guidance {
        return Ok(
            json!({"status":"unavailable","fields":gated,"snapshot":read(db,a,scope,options).await?}),
        );
    }
    let mut durable = input.clone();
    durable.as_object_mut().unwrap().remove("sessionId");
    durable.as_object_mut().unwrap().remove("commandKey");
    let result = commands::execute(
        db,
        a,
        Command {
            key: input["commandKey"].as_str().unwrap(),
            operation: &format!("{scope}Preferences.patch@1"),
            input: &durable,
            status: 200,
        },
        &Patch {
            input: &input,
            scope,
        },
    )
    .await;
    let mut response = match result {
        Ok(_) => json!({"status":"saved"}),
        Err(StoreError::PreferenceConflict(fields)) => json!({"status":"conflict","fields":fields}),
        Err(e) => return Err(e),
    };
    response["snapshot"] = read(db, a, scope, options).await?;
    Ok(response)
}
pub async fn directory(
    db: &Database,
    a: &Actor,
    workspace: &str,
    session_id: &str,
    options: PreferenceOptions,
) -> Result<Value, StoreError> {
    session(a, Some(session_id))?;
    if workspace != a.workspace_id {
        return Err(StoreError::Forbidden);
    }
    let mut tx = db.begin().await?;
    let a = current_actor(&mut tx, a).await?;
    session(&a, Some(session_id))?;
    if workspace != a.workspace_id || !a.has_scope(ApiScope::TeamsRead) {
        return Err(StoreError::Forbidden);
    }
    let enabled = options.enabled && options.names;
    let people = if enabled {
        let rows:Vec<(String,String,Option<String>)>=sqlx::query_as("SELECT u.id,u.name,u.username FROM member m JOIN \"user\" u ON u.id=m.user_id WHERE m.organization_id=$1").bind(&a.workspace_id).fetch_all(&mut *tx).await?;
        rows.into_iter()
            .map(|(id, name, username)| json!({"id":id,"name":name,"username":username}))
            .collect::<Vec<_>>()
    } else {
        vec![]
    };
    tx.commit().await?;
    Ok(json!({"enabled":enabled,"people":people}))
}
