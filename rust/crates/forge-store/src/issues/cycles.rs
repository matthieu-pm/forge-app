use super::*;
use crate::database::JournalTransaction;
use forge_core::cycles::{self as calendar, Settings};
#[derive(FromRow)]
struct Stored {
    id: Uuid,
    encoded_value: Option<String>,
    revision: i32,
}
#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct Cycle {
    id: Uuid,
    workspace_id: String,
    team_id: Uuid,
    number: i32,
    timezone: String,
    start_date: String,
    end_date: String,
}
fn key(team: Uuid, kind: &str) -> String {
    format!("forge:team-{kind}:v1:{team}")
}
async fn lock(connection: &mut PgConnection, team: Uuid) -> Result<(), StoreError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,4055))")
        .bind(team.to_string())
        .execute(connection)
        .await?;
    Ok(())
}
pub(super) async fn import_date(
    c: &mut PgConnection,
    a: &Actor,
    team: Uuid,
    start: &str,
) -> Result<Uuid, StoreError> {
    lock(c, team).await?;
    if let Some(id) = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM issue_cycles WHERE team_id=$1 AND start_date=$2",
    )
    .bind(team)
    .bind(start)
    .fetch_optional(&mut *c)
    .await?
    {
        return Ok(id);
    }
    fields::require_team(c, a, team).await?;
    let stored = stored(c, a, team, "cycles").await?;
    let settings = decoded(stored.as_ref(), "cycles")?;
    let zone = timezone(c, team, &settings).await?;
    let end = calendar::add_days(
        start,
        settings["duration"]
            .as_i64()
            .ok_or(StoreError::InvalidInput)?
            * 7
            - 1,
    )
    .map_err(|_| StoreError::InvalidInput)?;
    Ok(sqlx::query_scalar("INSERT INTO issue_cycles(workspace_id,team_id,start_date,end_date,timezone) VALUES($1,$2,$3,$4,$5) RETURNING id").bind(&a.workspace_id).bind(team).bind(start).bind(end).bind(zone).fetch_one(c).await?)
}
async fn stored(
    connection: &mut PgConnection,
    actor: &Actor,
    team: Uuid,
    kind: &str,
) -> Result<Option<Stored>, StoreError> {
    Ok(sqlx::query_as("SELECT id,encoded_value,revision FROM product_state WHERE workspace_id=$1 AND owner_id='workspace' AND key=$2").bind(&actor.workspace_id).bind(key(team,kind)).fetch_optional(connection).await?)
}
fn decoded(row: Option<&Stored>, kind: &str) -> Result<Value, StoreError> {
    let raw = if let Some(encoded) = row.and_then(|r| r.encoded_value.as_ref()) {
        let raw: String = serde_json::from_str(encoded).map_err(|_| StoreError::InvalidInput)?;
        serde_json::from_str(&raw).map_err(|_| StoreError::InvalidInput)?
    } else if kind == "cycles" {
        calendar::initial()
    } else {
        json!({"enabled":false,"requirePriority":false})
    };
    if kind == "cycles" {
        calendar::Settings::parse(raw)
            .map(calendar::Settings::into_value)
            .map_err(|_| StoreError::InvalidInput)
    } else {
        calendar::triage(raw).map_err(|_| StoreError::InvalidInput)
    }
}
async fn timezone(
    connection: &mut PgConnection,
    team: Uuid,
    settings: &Value,
) -> Result<String, StoreError> {
    let zone = if let Some(zone) = settings.get("timezone") {
        zone.clone()
    } else {
        json!(
            sqlx::query_scalar::<_, String>("SELECT timezone FROM teams WHERE id=$1")
                .bind(team)
                .fetch_one(connection)
                .await?
        )
    };
    Ok(calendar::timezone(zone)
        .map_err(|_| invalid("Choose a valid IANA timezone."))?
        .as_str()
        .unwrap()
        .to_owned())
}
async fn pending(
    connection: &mut PgConnection,
    team: Uuid,
    settings: &Settings,
    zone: &str,
    now: DateTime<Utc>,
) -> Result<Vec<(String, String)>, StoreError> {
    if settings.as_value()["enabled"] != true {
        return Ok(vec![]);
    }
    let last: Option<String> = sqlx::query_scalar(
        "SELECT end_date FROM issue_cycles WHERE team_id=$1 ORDER BY start_date DESC LIMIT 1",
    )
    .bind(team)
    .fetch_optional(&mut *connection)
    .await?;
    let future:i64=sqlx::query_scalar("SELECT count(*) FROM (SELECT id FROM issue_cycles WHERE team_id=$1 AND start_date>($2::timestamptz AT TIME ZONE timezone)::date::text LIMIT 6) c").bind(team).bind(now).fetch_one(connection).await?;
    calendar::scheduled_dates(settings, zone, last.as_deref(), future as usize, now)
        .map_err(|_| invalid("The cycle schedule could not be calculated."))
}
async fn insert(
    connection: &mut PgConnection,
    actor: &Actor,
    team: Uuid,
    zone: &str,
    windows: Vec<(String, String)>,
) -> Result<(), StoreError> {
    for (start, end) in windows {
        sqlx::query("INSERT INTO issue_cycles(workspace_id,team_id,start_date,end_date,timezone) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING").bind(&actor.workspace_id).bind(team).bind(start).bind(end).bind(zone).execute(&mut *connection).await?;
    }
    Ok(())
}
pub async fn read_cycles(
    database: &Database,
    actor: &Actor,
    team: Uuid,
    number: Option<i64>,
) -> Result<Value, StoreError> {
    read_cycles_at(database, actor, team, number, Utc::now()).await
}
pub async fn read_cycles_at(
    database: &Database,
    actor: &Actor,
    team: Uuid,
    number: Option<i64>,
    now: DateTime<Utc>,
) -> Result<Value, StoreError> {
    if number.is_some_and(|n| !(1..=9_007_199_254_740_991).contains(&n)) {
        return Err(StoreError::InvalidInput);
    }
    let mut tx = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let actor = current_actor(&mut tx, actor).await?;
    policy::scope(&actor, ApiScope::IssuesRead)?;
    policy::team(&mut tx, &actor, team).await?;
    lock(&mut tx, team).await?;
    let row = stored(&mut tx, &actor, team, "cycles").await?;
    let mut settings = decoded(row.as_ref(), "cycles")?;
    let zone = timezone(&mut tx, team, &settings).await?;
    settings["timezone"] = json!(zone);
    let parsed = Settings::parse(settings.clone()).map_err(|_| StoreError::InvalidInput)?;
    let windows = pending(&mut tx, team, &parsed, &zone, now).await?;
    if !windows.is_empty() {
        tx.prepare().await?;
        insert(&mut tx, &actor, team, &zone, windows).await?;
    }
    let mut cycles:Vec<Cycle>=sqlx::query_as("SELECT * FROM issue_cycles WHERE team_id=$1 AND workspace_id=$2 ORDER BY start_date DESC LIMIT 100").bind(team).bind(&actor.workspace_id).fetch_all(&mut *tx).await?;
    if let Some(number) = number
        && !cycles.iter().any(|c| i64::from(c.number) == number)
        && let Some(selected) = sqlx::query_as::<_, Cycle>(
            "SELECT * FROM issue_cycles WHERE team_id=$1 AND number=$2::bigint",
        )
        .bind(team)
        .bind(number)
        .fetch_optional(&mut *tx)
        .await?
    {
        cycles.push(selected);
    }
    cycles.sort_by(|a, b| a.start_date.cmp(&b.start_date));
    let sql = format!(
        "SELECT i.cycle_id,count(*)::int,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM issue_statuses s WHERE s.workspace_id=i.workspace_id AND s.team_id=i.team_id AND s.id=i.status_id AND s.status_group='completed'))::int FROM issues i WHERE i.workspace_id=$1 AND i.team_id=$4 AND {} GROUP BY i.cycle_id",
        policy::readable_issue(&actor, "i.id")
    );
    let totals: Vec<(Option<Uuid>, i32, i32)> = sqlx::query_as(&sql)
        .bind(&actor.workspace_id)
        .bind(policy::privileged(&actor))
        .bind(&actor.user_id)
        .bind(team)
        .fetch_all(&mut *tx)
        .await?;
    let mut first_future = true;
    let mut result = vec![];
    for cycle in cycles {
        let today = calendar::today(&cycle.timezone, now).map_err(|_| StoreError::InvalidInput)?;
        let state = if cycle.end_date < today {
            "Past"
        } else if cycle.start_date <= today {
            "Current"
        } else if first_future {
            first_future = false;
            "Upcoming"
        } else {
            "Planned"
        };
        let total = totals.iter().find(|t| t.0 == Some(cycle.id));
        let mut value = serde_json::to_value(cycle).map_err(|_| StoreError::InvalidInput)?;
        value["issueCount"] = json!(total.map_or(0, |t| t.1));
        value["completedCount"] = json!(total.map_or(0, |t| t.2));
        value["state"] = json!(state);
        result.push(value);
    }
    tx.commit().await?;
    Ok(
        json!({"workspaceId":actor.workspace_id,"userId":actor.user_id,"sessionId":session(&actor),"settings":settings,"revision":row.map_or(0,|r|r.revision),"canManage":policy::privileged(&actor),"cycles":result}),
    )
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    revision: i32,
}
struct Save<'a> {
    input: &'a Value,
    team: Uuid,
    kind: &'a str,
}
#[async_trait]
impl CommandHandler for Save<'_> {
    type Output = Saved;
    async fn authorize(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
        _value: Option<&Saved>,
    ) -> Result<(), StoreError> {
        if !matches!(actor.authentication, Authentication::Session { .. })
            || !policy::privileged(actor)
        {
            return Err(StoreError::Forbidden);
        }
        mutation_fence(connection, actor).await?;
        policy::team(connection, actor, self.team).await
    }
    async fn run(
        &self,
        connection: &mut PgConnection,
        actor: &Actor,
    ) -> Result<CommandResult<Saved>, StoreError> {
        if self.kind == "cycles" {
            lock(connection, self.team).await?;
        }
        let key = key(self.team, self.kind);
        sqlx::query("INSERT INTO product_state(workspace_id,owner_id,team_id,key,encoded_value) VALUES($1,'workspace',$2,$3,NULL) ON CONFLICT DO NOTHING").bind(&actor.workspace_id).bind(self.team).bind(&key).execute(&mut *connection).await?;
        let row:Stored=sqlx::query_as("SELECT id,encoded_value,revision FROM product_state WHERE workspace_id=$1 AND owner_id='workspace' AND key=$2 FOR UPDATE").bind(&actor.workspace_id).bind(&key).fetch_one(&mut *connection).await?;
        let value = &self.input["value"];
        if self.input["expectedRevision"] != row.revision {
            let prior: Value = if let Some(encoded) = row.encoded_value {
                serde_json::from_str(&encoded).map_err(|_| StoreError::InvalidInput)?
            } else {
                Value::Null
            };
            if prior == *value {
                return Ok(CommandResult {
                    value: Saved {
                        revision: row.revision,
                    },
                    resource_type: "productState".into(),
                    resource_id: row.id.to_string(),
                    events: vec![],
                });
            }
            return Err(invalid(
                "This data changed in another session. Your pending changes are preserved in this session; reload the latest version before retrying.",
            ));
        }
        sqlx::query("UPDATE product_state SET encoded_value=$1,revision=revision+1 WHERE id=$2")
            .bind(if value.is_null() {
                None
            } else {
                Some(value.to_string())
            })
            .bind(row.id)
            .execute(&mut *connection)
            .await?;
        if self.kind == "cycles"
            && let Some(raw) = value.as_str()
        {
            let settings =
                Settings::parse(serde_json::from_str(raw).map_err(|_| StoreError::InvalidInput)?)
                    .map_err(|_| StoreError::InvalidInput)?;
            if settings.as_value()["enabled"] == true {
                let zone = timezone(connection, self.team, settings.as_value()).await?;
                let windows = pending(connection, self.team, &settings, &zone, Utc::now()).await?;
                insert(connection, actor, self.team, &zone, windows).await?;
            }
        }
        Ok(CommandResult {
            value: Saved {
                revision: row.revision + 1,
            },
            resource_type: "productState".into(),
            resource_id: row.id.to_string(),
            events: vec![],
        })
    }
}
pub async fn save_team_settings(
    database: &Database,
    actor: &Actor,
    input: Value,
) -> Result<Value, StoreError> {
    let input = calendar::settings_command(input).map_err(|_| StoreError::InvalidInput)?;
    let team = id(&input, "teamId")?;
    let kind = text(&input, "kind");
    // Preserve source receipt identity and its original serialized value.
    let payload = json!({"workspaceId":actor.workspace_id,"key":key(team,kind),"value":input["value"],"expectedRevision":input["expectedRevision"]});
    let result = commands::execute(
        database,
        actor,
        Command {
            key: text(&input, "commandKey"),
            operation: "productState.save@1",
            input: &payload,
            status: 200,
        },
        &Save {
            input: &input,
            team,
            kind,
        },
    )
    .await?;
    Ok(json!({"value":result.value,"replayed":result.replayed}))
}
pub async fn read_triage(
    database: &Database,
    actor: &Actor,
    team: Uuid,
) -> Result<Value, StoreError> {
    let mut tx: JournalTransaction = database.begin().await?;
    lock_workspace(&mut tx, &actor.workspace_id, false).await?;
    let actor = current_actor(&mut tx, actor).await?;
    if !matches!(actor.authentication, Authentication::Session { .. }) {
        return Err(StoreError::Forbidden);
    }
    policy::team(&mut tx, &actor, team).await?;
    let row = stored(&mut tx, &actor, team, "triage").await?;
    let settings = decoded(row.as_ref(), "triage")?;
    tx.commit().await?;
    Ok(
        json!({"workspaceId":actor.workspace_id,"userId":actor.user_id,"sessionId":session(&actor),"settings":settings,"revision":row.map_or(0,|r|r.revision),"canManage":policy::privileged(&actor)}),
    )
}
