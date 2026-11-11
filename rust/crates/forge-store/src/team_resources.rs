use crate::{
    Database, StoreError,
    authority::current_actor,
    commands::{self, Command, CommandHandler, CommandResult, OutboxEvent},
    resource_policy as policy,
    workspaces::lock_workspace,
};
use async_trait::async_trait;
use forge_core::{
    actor::{Actor, Authentication},
    team_resources as contract,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use uuid::Uuid;
#[derive(Clone, Copy)]
pub struct ResourceOptions {
    pub enabled: bool,
}
impl ResourceOptions {
    pub fn from_env() -> Self {
        Self {
            enabled: crate::documents::DocumentOptions::from_env().team_resources,
        }
    }
}
async fn authorize(
    c: &mut PgConnection,
    a: &Actor,
    team: Uuid,
    options: ResourceOptions,
) -> Result<(), StoreError> {
    if !options.enabled
        || !matches!(a.authentication, Authentication::Session { .. })
        || a.scopes.is_some()
    {
        return Err(StoreError::Forbidden);
    }
    sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
        .bind(&a.workspace_id)
        .fetch_one(&mut *c)
        .await?;
    sqlx::query("SELECT id FROM team_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE")
        .bind(&a.workspace_id)
        .bind(&a.user_id)
        .fetch_all(&mut *c)
        .await?;
    policy::team(c, a, team).await
}
async fn snapshot(c: &mut PgConnection, team: Uuid) -> Result<Value, StoreError> {
    let row: Option<(Value, i32)> =
        sqlx::query_as("SELECT fields,revision FROM team_resource_boards WHERE team_id=$1")
            .bind(team)
            .fetch_optional(c)
            .await?;
    if let Some((fields, revision)) = row {
        let mut value = contract::fields(fields).map_err(|_| StoreError::InvalidInput)?;
        value["revision"] = json!(revision);
        Ok(value)
    } else {
        Ok(contract::empty())
    }
}
pub async fn read(
    db: &Database,
    a: &Actor,
    team: Uuid,
    options: ResourceOptions,
) -> Result<Value, StoreError> {
    let mut tx = db.begin().await?;
    lock_workspace(&mut tx, &a.workspace_id, false).await?;
    let a = current_actor(&mut tx, a).await?;
    authorize(&mut tx, &a, team, options).await?;
    let value = snapshot(&mut tx, team).await?;
    tx.commit().await?;
    Ok(value)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    #[serde(deserialize_with = "positive")]
    revision: i32,
}
fn positive<'de, D: serde::Deserializer<'de>>(d: D) -> Result<i32, D::Error> {
    let n = i32::deserialize(d)?;
    if n > 0 {
        Ok(n)
    } else {
        Err(serde::de::Error::custom("positive revision"))
    }
}
struct Write<'a> {
    input: &'a Value,
    team: Uuid,
    options: ResourceOptions,
}
#[async_trait]
impl CommandHandler for Write<'_> {
    type Output = Saved;
    async fn authorize(
        &self,
        c: &mut PgConnection,
        a: &Actor,
        _: Option<&Saved>,
    ) -> Result<(), StoreError> {
        authorize(c, a, self.team, self.options).await
    }
    async fn run(
        &self,
        c: &mut PgConnection,
        a: &Actor,
    ) -> Result<CommandResult<Saved>, StoreError> {
        let old = snapshot(c, self.team).await?;
        if old["revision"] != self.input["expectedRevision"] {
            return Err(StoreError::ResourceConflict);
        }
        let revision = i32::try_from(old["revision"].as_i64().unwrap() + 1)
            .map_err(|_| StoreError::InvalidInput)?;
        sqlx::query("INSERT INTO team_resource_boards(team_id,workspace_id,fields,revision,updated_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(team_id) DO UPDATE SET fields=excluded.fields,revision=excluded.revision,updated_at=excluded.updated_at").bind(self.team).bind(&a.workspace_id).bind(&self.input["fields"]).bind(revision).execute(c).await?;
        Ok(CommandResult {
            value: Saved { revision },
            resource_type: "team-resources".into(),
            resource_id: self.input["teamId"].as_str().unwrap().into(),
            events: vec![OutboxEvent {
                topic: "team.resources.updated".into(),
                payload: json!({"teamId":self.input["teamId"],"revision":revision})
                    .as_object()
                    .unwrap()
                    .clone(),
            }],
        })
    }
}
pub async fn command(
    db: &Database,
    a: &Actor,
    key: &str,
    input: Value,
    options: ResourceOptions,
) -> Result<Value, StoreError> {
    if !forge_core::text::is_uuid(key) {
        return Err(StoreError::InvalidInput);
    }
    let input = contract::command(input).map_err(|_| StoreError::InvalidInput)?;
    let team = input["teamId"]
        .as_str()
        .unwrap()
        .parse()
        .map_err(|_| StoreError::InvalidInput)?;
    match commands::execute(
        db,
        a,
        Command {
            key,
            operation: "team-resources.write@1",
            input: &input,
            status: 200,
        },
        &Write {
            input: &input,
            team,
            options,
        },
    )
    .await
    {
        Ok(result) => Ok(json!({"status":"saved","revision":result.value.revision})),
        Err(StoreError::ResourceConflict) => {
            Ok(json!({"status":"conflict","current":read(db,a,team,options).await?}))
        }
        Err(e) => Err(e),
    }
}
