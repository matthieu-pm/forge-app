mod jobs;
use crate::{
    Database, StoreError,
    authority::current_actor,
    commands::{self, Command, CommandHandler, CommandResult, OutboxEvent},
};
use forge_core::{
    actor::{Actor, Authentication},
    sla as contract,
};
pub use jobs::{BreachJob, KIND, dispatch, run_jobs};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::collections::HashSet;
use uuid::Uuid;

fn text<'a>(input: &'a Value, key: &str) -> &'a str {
    input[key].as_str().unwrap_or("")
}
fn uuid(input: &Value, key: &str) -> Result<Uuid, StoreError> {
    text(input, key)
        .parse()
        .map_err(|_| StoreError::InvalidInput)
}
fn authority(db: &Database, a: &Actor, input: &Value) -> Result<(), StoreError> {
    if !db.sla_gate(&a.workspace_id).0
        || input["workspaceId"] != a.workspace_id
        || !matches!(&a.authentication,Authentication::Session { session_id } if input["sessionId"]==*session_id)
        || !a.has_role(&["owner", "admin"])
    {
        return Err(StoreError::Forbidden);
    }
    Ok(())
}
async fn workspace(tx: &mut PgConnection, a: &Actor) -> Result<(), StoreError> {
    sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
        .bind(&a.workspace_id)
        .execute(tx)
        .await?;
    Ok(())
}
pub(super) async fn configure(
    db: &Database,
    tx: &mut PgConnection,
    workspace: &str,
) -> Result<(bool, String), StoreError> {
    let gate = db.sla_gate(workspace);
    sqlx::query("SELECT set_config('forge.sla.workspace',$1,true),set_config('forge.sla.enabled',$2,true),set_config('forge.sla.identity',$3,true)").bind(workspace).bind(if gate.0{"on"}else{"off"}).bind(&gate.1).execute(tx).await?;
    Ok(gate)
}
#[derive(sqlx::FromRow)]
struct UncertainCommitment {
    id: Uuid,
    issue_id: Uuid,
    deadline: String,
    gate_identity: String,
    classified_through: Option<String>,
    owed_at: Option<String>,
}
async fn snapshot(db: &Database, tx: &mut PgConnection, a: &Actor) -> Result<Value, StoreError> {
    let row: Option<(i32, Value)> =
        sqlx::query_as("SELECT revision,\"values\" FROM sla_policies WHERE workspace_id=$1")
            .bind(&a.workspace_id)
            .fetch_optional(&mut *tx)
            .await?;
    let (revision, values) = match row {
        Some((r, v)) => (
            r,
            contract::policy(v).map_err(|_| StoreError::InvalidInput)?,
        ),
        None => (0, contract::initial()),
    };
    let uncertain:Vec<UncertainCommitment>=sqlx::query_as("SELECT id,issue_id,deadline_at::text AS deadline,gate_identity,classified_through::text,owed_at::text FROM issue_slas WHERE workspace_id=$1 AND gate_uncertain AND owed_at IS NOT NULL LIMIT 100").bind(&a.workspace_id).fetch_all(&mut *tx).await?;
    let reconciliation=uncertain.into_iter().map(|row|json!({"id":row.id,"issueId":row.issue_id,"deadline":row.deadline,"version":contract::reconciliation_version(&row.id.to_string(),&row.gate_identity,row.classified_through.as_deref(),row.owed_at.as_deref(),&db.sla_gate(&a.workspace_id).1)})).collect::<Vec<_>>();
    let teams:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'name',name,'timezone',timezone) FROM teams WHERE workspace_id=$1 AND deleted_at IS NULL").bind(&a.workspace_id).fetch_all(&mut *tx).await?;
    let statuses:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',s.id,'teamId',s.team_id,'name',s.name) FROM issue_statuses s JOIN teams t ON t.id=s.team_id AND t.workspace_id=s.workspace_id WHERE s.workspace_id=$1 AND t.deleted_at IS NULL").bind(&a.workspace_id).fetch_all(&mut *tx).await?;
    Ok(
        json!({"revision":revision,"values":values,"canManage":true,"reconciliation":reconciliation,"teams":teams,"statuses":statuses}),
    )
}
pub async fn read(db: &Database, a: &Actor, raw: Value) -> Result<Value, StoreError> {
    let input = contract::read(raw).map_err(|_| StoreError::InvalidInput)?;
    let mut tx = db.begin().await?;
    let a = current_actor(&mut tx, a).await?;
    authority(db, &a, &input)?;
    let result = snapshot(db, &mut tx, &a).await?;
    tx.commit().await?;
    Ok(result)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Revision {
    revision: i32,
}
struct Policy<'a> {
    db: &'a Database,
    input: &'a Value,
}
#[async_trait::async_trait]
impl CommandHandler for Policy<'_> {
    type Output = Revision;
    async fn authorize(
        &self,
        _: &mut PgConnection,
        a: &Actor,
        _: Option<&Revision>,
    ) -> Result<(), StoreError> {
        authority(self.db, a, self.input)
    }
    async fn run(
        &self,
        tx: &mut PgConnection,
        a: &Actor,
    ) -> Result<CommandResult<Revision>, StoreError> {
        workspace(tx, a).await?;
        for rule in self.input["values"]["rules"]
            .as_array()
            .ok_or(StoreError::InvalidInput)?
        {
            let filters = &rule["filters"];
            let team_ids = filters
                .get("teamIds")
                .map(|ids| {
                    ids.as_array()
                        .unwrap()
                        .iter()
                        .map(|v| {
                            v.as_str()
                                .unwrap()
                                .parse::<Uuid>()
                                .map_err(|_| StoreError::InvalidInput)
                        })
                        .collect::<Result<Vec<_>, _>>()
                })
                .transpose()?;
            if let Some(ids) = &team_ids {
                let found:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM teams WHERE workspace_id=$1 AND id=ANY($2) AND deleted_at IS NULL FOR SHARE").bind(&a.workspace_id).bind(ids).fetch_all(&mut *tx).await?;
                let expected = filters["teamIds"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap())
                    .collect::<HashSet<_>>()
                    .len();
                if found.len() != expected {
                    return Err(StoreError::SlaPolicyValidation);
                }
            }
            if let Some(statuses) = filters.get("statuses") {
                let found:Vec<(String,Uuid)>=sqlx::query_as("SELECT s.id,s.team_id FROM issue_statuses s WHERE s.workspace_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements($2::jsonb) v WHERE s.team_id=(v->>'teamId')::uuid AND s.id=v->>'statusId') AND ($3::uuid[] IS NULL OR s.team_id=ANY($3)) FOR SHARE OF s").bind(&a.workspace_id).bind(statuses).bind(team_ids.as_deref()).fetch_all(&mut *tx).await?;
                let expected = statuses
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| format!("{}:{}", text(s, "teamId"), text(s, "statusId")))
                    .collect::<HashSet<_>>()
                    .len();
                if found.len() != expected {
                    return Err(StoreError::SlaPolicyValidation);
                }
            }
        }
        let revision: Option<i32> = if self.input["expectedRevision"] == 0 {
            sqlx::query_scalar("INSERT INTO sla_policies(workspace_id,\"values\") VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING revision").bind(&a.workspace_id).bind(&self.input["values"]).fetch_optional(&mut *tx).await?
        } else {
            sqlx::query_scalar("UPDATE sla_policies SET \"values\"=$2 WHERE workspace_id=$1 AND revision=$3 RETURNING revision").bind(&a.workspace_id).bind(&self.input["values"]).bind(self.input["expectedRevision"].as_i64().ok_or(StoreError::InvalidInput)?).fetch_optional(&mut *tx).await?
        };
        let revision = revision.ok_or(StoreError::SlaPolicyConflict)?;
        Ok(CommandResult {
            value: Revision { revision },
            resource_type: "sla-policy".into(),
            resource_id: a.workspace_id.clone(),
            events: vec![OutboxEvent {
                topic: "sla.policy.updated".into(),
                payload: json!({"revision":revision,"enabled":self.input["values"]["enabled"]})
                    .as_object()
                    .unwrap()
                    .clone(),
            }],
        })
    }
}
pub async fn save(db: &Database, a: &Actor, raw: Value) -> Result<Value, StoreError> {
    let input = contract::command(raw).map_err(|_| StoreError::InvalidInput)?;
    let result = commands::execute(
        db,
        a,
        Command {
            key: text(&input, "commandKey"),
            operation: "sla.policy@1",
            input: &input,
            status: 200,
        },
        &Policy { db, input: &input },
    )
    .await;
    let mut result = match result {
        Ok(r) => json!({"status":"saved","replayed":r.replayed}),
        Err(StoreError::SlaPolicyConflict) => json!({"status":"conflict"}),
        Err(StoreError::SlaPolicyValidation) => {
            json!({"status":"invalid","message":StoreError::SlaPolicyValidation.to_string()})
        }
        Err(e) => return Err(e),
    };
    result["snapshot"] = read(
        db,
        a,
        json!({"workspaceId":input["workspaceId"],"sessionId":input["sessionId"]}),
    )
    .await?;
    Ok(result)
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reconciled {
    commitment_id: Uuid,
}
struct Reconcile<'a> {
    db: &'a Database,
    input: &'a Value,
    id: Uuid,
}
#[async_trait::async_trait]
impl CommandHandler for Reconcile<'_> {
    type Output = Reconciled;
    async fn authorize(
        &self,
        tx: &mut PgConnection,
        a: &Actor,
        _: Option<&Reconciled>,
    ) -> Result<(), StoreError> {
        authority(self.db, a, self.input)?;
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM issue_slas WHERE id=$1 AND workspace_id=$2)",
        )
        .bind(self.id)
        .bind(&a.workspace_id)
        .fetch_one(tx)
        .await?;
        if !exists {
            return Err(StoreError::Forbidden);
        }
        Ok(())
    }
    async fn run(
        &self,
        tx: &mut PgConnection,
        a: &Actor,
    ) -> Result<CommandResult<Reconciled>, StoreError> {
        workspace(tx, a).await?;
        let row:Option<(bool,String,Option<String>,Option<String>)>=sqlx::query_as("SELECT gate_uncertain,gate_identity,classified_through::text,owed_at::text FROM issue_slas WHERE id=$1 FOR UPDATE").bind(self.id).fetch_optional(&mut *tx).await?;
        let (uncertain, gate, classified, owed) = row.ok_or(StoreError::Forbidden)?;
        let current_gate = self.db.sla_gate(&a.workspace_id).1;
        if !uncertain
            || self.input["expectedVersion"]
                != contract::reconciliation_version(
                    &self.id.to_string(),
                    &gate,
                    classified.as_deref(),
                    owed.as_deref(),
                    &current_gate,
                )
        {
            return Err(StoreError::SlaReconciliationConflict);
        }
        sqlx::query("UPDATE issue_slas SET gate_uncertain=false,gate_identity=$2,classified_through=clock_timestamp(),owed_at=CASE WHEN $3 THEN coalesce(owed_at,clock_timestamp()) ELSE NULL END WHERE id=$1").bind(self.id).bind(current_gate).bind(self.input["decision"]=="breach-owed").execute(&mut *tx).await?;
        sqlx::query("SELECT forge_sla_breach($1,clock_timestamp())")
            .bind(self.id)
            .execute(&mut *tx)
            .await?;
        Ok(CommandResult {value:Reconciled{commitment_id:self.id},resource_type:"sla-commitment".into(),resource_id:self.id.to_string(),events:vec![OutboxEvent{topic:"sla.gate.reconciled".into(),payload:json!({"commitmentId":self.id,"decision":self.input["decision"],"evidence":self.input["evidence"]}).as_object().unwrap().clone()}]})
    }
}
pub async fn reconcile(db: &Database, a: &Actor, raw: Value) -> Result<Value, StoreError> {
    let input = contract::reconciliation(raw).map_err(|_| StoreError::InvalidInput)?;
    let id = uuid(&input, "commitmentId")?;
    let result = commands::execute(
        db,
        a,
        Command {
            key: text(&input, "commandKey"),
            operation: "sla.reconcile@1",
            input: &input,
            status: 200,
        },
        &Reconcile {
            db,
            input: &input,
            id,
        },
    )
    .await?;
    Ok(json!({"value":result.value,"replayed":result.replayed}))
}
