//! Workspace/team template authoring, defaults and recurring-issue definitions.
use crate::{Database, StoreError, authority::current_actor, teams, workspaces::lock_workspace};
use chrono::{DateTime, SecondsFormat, Utc};
use forge_core::{
    actor::{Actor, Authentication},
    templates as contract,
};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection};
use std::collections::HashSet;
use uuid::Uuid;

struct Scope {
    actor: Actor,
    directory: Value,
    team: Option<Uuid>,
    allowed: HashSet<String>,
}
async fn scope(
    c: &mut PgConnection,
    actor: &Actor,
    input: &Value,
    write: bool,
) -> Result<Scope, StoreError> {
    if !matches!(actor.authentication, Authentication::Session { .. }) || actor.scopes.is_some() {
        return Err(StoreError::Forbidden);
    }
    if write {
        sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
            .bind(&actor.workspace_id)
            .fetch_optional(&mut *c)
            .await?
            .ok_or(StoreError::Forbidden)?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,4040))")
            .bind(&actor.workspace_id)
            .execute(&mut *c)
            .await?;
    } else {
        lock_workspace(c, &actor.workspace_id, false).await?;
    }
    let actor = current_actor(c, actor).await?;
    if write && !actor.can_manage_teams() {
        return Err(StoreError::Forbidden);
    }
    let directory = teams::directory_in(c, &actor, false).await?;
    let items = directory["items"]
        .as_array()
        .ok_or(StoreError::InvalidInput)?;
    let allowed = items
        .iter()
        .filter_map(|t| t["id"].as_str().map(str::to_owned))
        .collect();
    let team = if let Some(slug) = input["slug"].as_str() {
        Some(
            items
                .iter()
                .find(|t| t["slug"] == slug)
                .and_then(|t| t["id"].as_str())
                .ok_or(StoreError::Forbidden)?
                .parse()
                .map_err(|_| StoreError::InvalidInput)?,
        )
    } else {
        None
    };
    Ok(Scope {
        actor,
        directory,
        team,
        allowed,
    })
}
fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn uuid(v: &Value) -> Result<Uuid, StoreError> {
    v.as_str()
        .ok_or(StoreError::InvalidInput)?
        .parse()
        .map_err(|_| StoreError::InvalidInput)
}
fn table(recurring: bool) -> &'static str {
    if recurring {
        "team_recurring_issues"
    } else {
        "team_templates"
    }
}
#[derive(FromRow)]
struct Row {
    id: Uuid,
    payload: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    creator: String,
}
impl Row {
    fn value(self, recurring: bool) -> Result<Value, StoreError> {
        let payload =
            forge_core::json::parse(&self.payload).map_err(|_| StoreError::InvalidInput)?;
        let mut v = json!({"id":self.id,"payload":payload,"createdAt":stamp(self.created_at),"updatedAt":stamp(self.updated_at)});
        if !recurring {
            v["createdBy"] = json!(self.creator);
        }
        Ok(v)
    }
}
pub async fn read(
    db: &Database,
    actor: &Actor,
    input: Value,
    recurring: bool,
) -> Result<Value, StoreError> {
    let mut tx = db.begin().await?;
    let result = read_in(&mut tx, actor, input, recurring).await?;
    tx.commit().await?;
    Ok(result)
}
pub(crate) async fn read_in(
    c: &mut PgConnection,
    actor: &Actor,
    input: Value,
    recurring: bool,
) -> Result<Value, StoreError> {
    let input = contract::scope(input, recurring).map_err(|_| StoreError::InvalidInput)?;
    let s = scope(c, actor, &input, false).await?;
    let rows:Vec<Row>=sqlx::query_as(&format!("SELECT t.id,t.payload::text payload,t.created_at,t.updated_at,u.name creator FROM {} t JOIN \"user\" u ON u.id=t.created_by_user_id WHERE t.workspace_id=$1 AND t.team_id IS NOT DISTINCT FROM $2 ORDER BY t.created_at DESC,t.id",table(recurring))).bind(&s.actor.workspace_id).bind(s.team).fetch_all(&mut *c).await?;
    let records: Vec<_> = rows
        .into_iter()
        .map(|r| r.value(recurring))
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|r| {
            recurring
                || r["payload"]["visibility"].is_null()
                || r["payload"]["visibility"] == ""
                || r["payload"]["visibility"]
                    .as_str()
                    .is_some_and(|id| s.allowed.contains(id))
        })
        .collect();
    let result = if recurring {
        json!(records)
    } else {
        let defaults: Vec<(String, Option<Uuid>)> = sqlx::query_as(
            "SELECT audience,template_id FROM team_template_defaults WHERE team_id=$1",
        )
        .bind(s.team)
        .fetch_all(&mut *c)
        .await?;
        let people:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',m.user_id,'name',u.name,'username',u.username,'image',u.image) FROM member m JOIN \"user\" u ON u.id=m.user_id WHERE m.organization_id=$1 ORDER BY m.created_at,m.id").bind(&s.actor.workspace_id).fetch_all(&mut *c).await?;
        json!({"templates":records,"defaults":{"members":defaults.iter().find(|(a,_)|a=="members").and_then(|(_,id)|*id),"nonMembers":defaults.iter().find(|(a,_)|a=="nonMembers").and_then(|(_,id)|*id)},"teams":s.directory["items"],"members":people,"canManage":s.actor.can_manage_teams()})
    };
    Ok(result)
}
async fn references(
    c: &mut PgConnection,
    s: &Scope,
    payload: &Value,
    recurring: bool,
) -> Result<(), StoreError> {
    if !recurring {
        if s.team.is_none() && payload["kind"] != "issue" && payload["kind"] != "project" {
            return Err(StoreError::Template(
                "Only workspace issue and project templates are supported.",
            ));
        }
        let visible = payload["visibility"]
            .as_str()
            .ok_or(StoreError::InvalidInput)?;
        if if s.team.is_some() {
            !s.allowed.contains(visible)
        } else {
            !visible.is_empty() && (payload["kind"] != "project" || !s.allowed.contains(visible))
        } {
            return Err(StoreError::Forbidden);
        }
    } else if payload["properties"]["teamIds"] != json!([s.team.ok_or(StoreError::Forbidden)?]) {
        return Err(StoreError::Forbidden);
    }
    let people: HashSet<String> =
        sqlx::query_scalar("SELECT user_id FROM member WHERE organization_id=$1 FOR SHARE")
            .bind(&s.actor.workspace_id)
            .fetch_all(&mut *c)
            .await?
            .into_iter()
            .collect();
    let mut properties = vec![&payload["properties"]];
    for key in if recurring {
        &["subIssues"][..]
    } else {
        &["issues", "subIssues"][..]
    } {
        for item in payload[*key].as_array().ok_or(StoreError::InvalidInput)? {
            properties.push(&item["properties"]);
        }
    }
    for p in properties {
        let ids = p["teamIds"].as_array().ok_or(StoreError::InvalidInput)?;
        if (s.team.is_some() && ids.is_empty())
            || ids
                .iter()
                .any(|id| id.as_str().is_none_or(|id| !s.allowed.contains(id)))
        {
            return Err(StoreError::Forbidden);
        }
        for id in [&p["assignee"], &p["lead"]]
            .into_iter()
            .chain(p["members"].as_array().ok_or(StoreError::InvalidInput)?)
        {
            if !id.is_null() && id.as_str().is_none_or(|id| !people.contains(id)) {
                return Err(StoreError::Forbidden);
            }
        }
    }
    Ok(())
}
pub async fn save(
    db: &Database,
    actor: &Actor,
    input: Value,
    recurring: bool,
) -> Result<Value, StoreError> {
    let input = contract::save(input, recurring).map_err(|_| StoreError::InvalidInput)?;
    let mut tx = db.begin().await?;
    let s = scope(&mut tx, actor, &input, true).await?;
    let payload = &input["payload"];
    references(&mut tx, &s, payload, recurring).await?;
    let id = input.get("id").map(uuid).transpose()?;
    let previous: Option<(Option<String>, DateTime<Utc>)> = if let Some(id) = id {
        Some(sqlx::query_as(&format!("SELECT payload->>'kind',updated_at FROM {} WHERE id=$1 AND workspace_id=$2 AND team_id IS NOT DISTINCT FROM $3 FOR UPDATE",table(recurring))).bind(id).bind(&s.actor.workspace_id).bind(s.team).fetch_optional(&mut *tx).await?.ok_or(StoreError::Forbidden)?)
    } else {
        None
    };
    if let Some((old, updated)) = &previous {
        if !recurring && old.as_deref() != payload["kind"].as_str() {
            return Err(StoreError::Template(
                "A template type cannot be changed after creation.",
            ));
        }
        if input["updatedAt"] != stamp(*updated) {
            return Err(StoreError::TemplateConflict);
        }
    }
    if !recurring {
        let duplicates:Vec<(Uuid,String)>=sqlx::query_as("SELECT id,payload->>'name' FROM team_templates WHERE workspace_id=$1 AND team_id IS NOT DISTINCT FROM $2 AND payload->>'kind'=$3").bind(&s.actor.workspace_id).bind(s.team).bind(payload["kind"].as_str().unwrap()).fetch_all(&mut *tx).await?;
        let name = payload["name"].as_str().unwrap().to_lowercase();
        if duplicates
            .iter()
            .any(|(other, n)| Some(*other) != id && n.to_lowercase() == name)
        {
            return Err(StoreError::Template(
                "A template with this name already exists.",
            ));
        }
    }
    tx.prepare().await?;
    let id = if let Some(id) = id {
        // Return millisecond revisions like JavaScript Date, and always advance
        // them even for two saves within a millisecond or a future legacy row.
        sqlx::query(&format!("UPDATE {} SET payload=$2,updated_at=GREATEST(date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',updated_at)+interval '1 millisecond') WHERE id=$1",table(recurring))).bind(id).bind(payload).execute(&mut *tx).await?;
        id
    } else {
        sqlx::query_scalar(&format!("INSERT INTO {}(workspace_id,team_id,created_by_user_id,payload,created_at,updated_at) VALUES($1,$2,$3,$4,date_trunc('milliseconds',clock_timestamp()),date_trunc('milliseconds',clock_timestamp())) RETURNING id",table(recurring))).bind(&s.actor.workspace_id).bind(s.team).bind(&s.actor.user_id).bind(payload).fetch_one(&mut *tx).await?
    };
    tx.commit().await?;
    Ok(json!({"id":id}))
}
pub async fn delete(
    db: &Database,
    actor: &Actor,
    input: Value,
    recurring: bool,
) -> Result<Value, StoreError> {
    let input = contract::delete(input, recurring).map_err(|_| StoreError::InvalidInput)?;
    let mut tx = db.begin().await?;
    let s = scope(&mut tx, actor, &input, true).await?;
    let id = uuid(&input["id"])?;
    let updated:Option<DateTime<Utc>>=sqlx::query_scalar(&format!("SELECT updated_at FROM {} WHERE id=$1 AND workspace_id=$2 AND team_id IS NOT DISTINCT FROM $3 FOR UPDATE",table(recurring))).bind(id).bind(&s.actor.workspace_id).bind(s.team).fetch_optional(&mut *tx).await?;
    if recurring && updated.is_none_or(|at| input["updatedAt"] != stamp(at)) {
        return Err(StoreError::TemplateConflict);
    }
    if updated.is_some() {
        tx.prepare().await?;
        sqlx::query(&format!("DELETE FROM {} WHERE id=$1", table(recurring)))
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(json!({"ok":true}))
}
pub async fn set_default(db: &Database, actor: &Actor, input: Value) -> Result<Value, StoreError> {
    let input = contract::default_selection(input).map_err(|_| StoreError::InvalidInput)?;
    let mut tx = db.begin().await?;
    let s = scope(&mut tx, actor, &input, true).await?;
    let team = s.team.ok_or(StoreError::Forbidden)?;
    let id = if input["templateId"].is_null() {
        None
    } else {
        Some(uuid(&input["templateId"])?)
    };
    if let Some(id) = id {
        let payload:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('kind',payload->'kind','issueType',payload->'issueType') FROM team_templates WHERE id=$1 AND workspace_id=$2 AND team_id=$3 FOR SHARE").bind(id).bind(&s.actor.workspace_id).bind(team).fetch_optional(&mut *tx).await?;
        if payload.as_ref().is_none_or(|p| {
            p["kind"] != "issue" || (input["audience"] == "members" && p["issueType"] == "form")
        }) {
            return Err(StoreError::Template(
                "Choose an eligible issue template from this team.",
            ));
        }
    }
    tx.prepare().await?;
    sqlx::query("INSERT INTO team_template_defaults(team_id,audience,template_id) VALUES($1,$2,$3) ON CONFLICT(team_id,audience) DO UPDATE SET template_id=EXCLUDED.template_id").bind(team).bind(input["audience"].as_str().unwrap()).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(json!({"ok":true}))
}
