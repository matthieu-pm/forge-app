use crate::{
    Database, StoreError,
    accounts::User,
    authority::current_actor,
    commands::{self, Command, CommandHandler, CommandResult},
};
use chrono::{DateTime, SecondsFormat, Utc};
use forge_core::{
    actor::{Actor, Authentication},
    files::upload::Inspector,
    profiles as contract,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
fn authority(a: &Actor, input: Option<&Value>) -> Result<(), StoreError> {
    let Authentication::Session { session_id } = &a.authentication else {
        return Err(StoreError::Forbidden);
    };
    if input.is_some_and(|v| {
        v["sessionId"] != *session_id || v["expectedWorkspaceId"] != a.workspace_id
    }) {
        return Err(StoreError::Forbidden);
    }
    Ok(())
}
fn enabled(on: bool) -> Result<(), StoreError> {
    if on {
        Ok(())
    } else {
        Err(StoreError::ProfileDisabled)
    }
}
fn date(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn snapshot(u: User) -> Value {
    json!({"userId":u.id,"revision":date(u.updated_at),"name":u.name,"title":u.title.unwrap_or_default(),"username":u.username,"image":u.image})
}
pub async fn read(db: &Database, a: &Actor, on: bool) -> Result<Value, StoreError> {
    enabled(on)?;
    authority(a, None)?;
    let mut tx = db.begin().await?;
    let a = current_actor(&mut tx, a).await?;
    let row: User = sqlx::query_as("SELECT * FROM \"user\" WHERE id=$1")
        .bind(&a.user_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::Forbidden)?;
    tx.commit().await?;
    Ok(snapshot(row))
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Updated {
    user_id: String,
    revision: String,
}
struct Patch<'a>(&'a Value);
#[async_trait::async_trait]
impl CommandHandler for Patch<'_> {
    type Output = Updated;
    async fn authorize(
        &self,
        _: &mut PgConnection,
        a: &Actor,
        result: Option<&Updated>,
    ) -> Result<(), StoreError> {
        authority(a, Some(self.0))?;
        if result.is_some_and(|r| r.user_id != a.user_id) {
            return Err(StoreError::Forbidden);
        }
        Ok(())
    }
    async fn run(
        &self,
        tx: &mut PgConnection,
        a: &Actor,
    ) -> Result<CommandResult<Updated>, StoreError> {
        let row: User = sqlx::query_as("SELECT * FROM \"user\" WHERE id=$1 FOR UPDATE")
            .bind(&a.user_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(StoreError::Forbidden)?;
        if self.0["expectedRevision"] != date(row.updated_at) {
            return Err(StoreError::ProfileConflict);
        }
        let next = Utc::now().timestamp_millis().max(
            row.updated_at
                .timestamp_millis()
                .checked_add(1)
                .ok_or(StoreError::InvalidInput)?,
        );
        let next = DateTime::from_timestamp_millis(next).ok_or(StoreError::InvalidInput)?;
        let patch = &self.0["patch"];
        // A present null clears optional fields; absence preserves the stored value.
        sqlx::query("UPDATE \"user\" SET name=CASE WHEN $2::jsonb ? 'name' THEN $2->>'name' ELSE name END,title=CASE WHEN $2 ? 'title' THEN $2->>'title' ELSE title END,username=CASE WHEN $2 ? 'username' THEN $2->>'username' ELSE username END,image=CASE WHEN $2 ? 'image' THEN $2->>'image' ELSE image END,updated_at=$3 WHERE id=$1").bind(&a.user_id).bind(patch).bind(next).execute(tx).await?;
        Ok(CommandResult {
            value: Updated {
                user_id: a.user_id.clone(),
                revision: date(next),
            },
            resource_type: "accountProfile".into(),
            resource_id: a.user_id.clone(),
            events: vec![],
        })
    }
}
pub async fn patch(
    db: &Database,
    a: &Actor,
    raw: Value,
    on: bool,
    inspector: &dyn Inspector,
) -> Result<Value, StoreError> {
    enabled(on)?;
    let input = contract::command(raw).map_err(|_| StoreError::InvalidInput)?;
    authority(a, Some(&input))?;
    if let Some(image) = input["patch"]["image"].as_str()
        && let Err(e) = contract::validate_avatar(image, inspector).await
    {
        return Ok(json!({"status":"rejected","message":e.to_string()}));
    }
    let mut payload = input.clone();
    payload.as_object_mut().unwrap().remove("commandKey");
    payload.as_object_mut().unwrap().remove("sessionId");
    let result = commands::execute(
        db,
        a,
        Command {
            key: input["commandKey"].as_str().unwrap(),
            operation: "accountProfile.patch@1",
            input: &payload,
            status: 200,
        },
        &Patch(&input),
    )
    .await;
    let status = match result {
        Ok(_) => "saved",
        Err(StoreError::ProfileConflict) => "conflict",
        Err(StoreError::Database(sqlx::Error::Database(e)))
            if e.code().as_deref() == Some("23505")
                && e.constraint() == Some("user_username_unique") =>
        {
            return Ok(
                json!({"status":"rejected","message":"This username is already in use. Choose another username."}),
            );
        }
        Err(e) => return Err(e),
    };
    Ok(json!({"status":status,"snapshot":read(db,a,on).await?}))
}
