use super::*;
use crate::commands::{self, Command, CommandHandler, CommandResult, OutboxEvent};
use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use forge_core::security::SecurityAction;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    id: Uuid,
    #[serde(deserialize_with = "positive")]
    revision: i32,
}
fn positive<'de, D: serde::Deserializer<'de>>(d: D) -> Result<i32, D::Error> {
    let value = i32::deserialize(d)?;
    if value > 0 {
        Ok(value)
    } else {
        Err(serde::de::Error::custom("positive revision"))
    }
}
struct Mutation<'a> {
    service: &'a Service,
    team: Uuid,
    key: &'a str,
    input: &'a Value,
    secret: Option<&'a str>,
}
impl Mutation<'_> {
    fn action(&self) -> &str {
        self.input["action"].as_str().unwrap()
    }
    fn id(&self) -> Uuid {
        value_id(&self.input["id"]).expect("validated loop id")
    }
}
#[async_trait]
impl CommandHandler for Mutation<'_> {
    type Output = Saved;
    async fn before_actor(&self, c: &mut PgConnection, a: &Actor) -> Result<(), StoreError> {
        fence(c, a).await
    }
    async fn authorize(
        &self,
        c: &mut PgConnection,
        a: &Actor,
        _value: Option<&Saved>,
    ) -> Result<(), StoreError> {
        let visibility = team_access(c, a, self.team, self.service.options.enabled).await?;
        let policy = security::settings(c, &a.workspace_id).await?;
        let action = self.action();
        if [
            "create",
            "save",
            "enable",
            "disable",
            "delete",
            "rotate-webhook",
        ]
        .contains(&action)
            && !policy.allows(a, SecurityAction::LoopsManage)
        {
            return Err(StoreError::Forbidden);
        }
        if [
            "create",
            "save",
            "enable",
            "run-now",
            "approve",
            "deny",
            "rotate-webhook",
        ]
        .contains(&action)
            && !policy.allows(a, SecurityAction::AgentsInvoke)
        {
            return Err(StoreError::Forbidden);
        }
        if ["create", "save"].contains(&action)
            && visibility == "private"
            && self.input["fields"]["teamAccess"] != "this-team"
        {
            return Err(StoreError::Forbidden);
        }
        if action != "create" {
            let deleted:Option<Option<DateTime<Utc>>>=sqlx::query_scalar("SELECT deleted_at FROM team_loops WHERE workspace_id=$1 AND team_id=$2 AND id=$3 FOR SHARE").bind(&a.workspace_id).bind(self.team).bind(self.id()).fetch_optional(c).await?;
            if deleted.is_none() || (deleted.flatten().is_some() && action != "delete") {
                return Err(StoreError::Forbidden);
            }
        }
        Ok(())
    }
    async fn run(
        &self,
        c: &mut PgConnection,
        a: &Actor,
    ) -> Result<CommandResult<Saved>, StoreError> {
        let action = self.action();
        let id = self.id();
        let old: Option<Definition> =
            sqlx::query_as("SELECT * FROM team_loops WHERE id=$1 FOR UPDATE")
                .bind(id)
                .fetch_optional(&mut *c)
                .await?;
        if if action == "create" {
            old.is_some()
        } else {
            old.as_ref().is_none_or(|r| {
                r.deleted_at.is_some()
                    || Some(i64::from(r.revision)) != self.input["expectedRevision"].as_i64()
            })
        } {
            return Err(StoreError::LoopConflict);
        }
        let now = self.service.time();
        let external = (action == "enable"
            && old
                .as_ref()
                .is_some_and(|r| r.fields["trigger"]["kind"] == "webhook"))
            || (action == "save"
                && old.as_ref().is_some_and(|r| r.enabled)
                && self.input["fields"]["trigger"]["kind"] == "webhook");
        if external
            && !security::settings(c, &a.workspace_id)
                .await?
                .allows(a, SecurityAction::LoopsTriggerExternal)
        {
            return Err(StoreError::LoopPolicy(
                "Enable external Loop sources in workspace security before enabling a webhook Loop.",
            ));
        }
        if ["create", "save"].contains(&action)
            && self.input["fields"]["trigger"]["kind"] == "schedule"
        {
            let trigger = &self.input["fields"]["trigger"];
            let first = contract::start_instant(
                trigger["startAt"]
                    .as_str()
                    .ok_or(StoreError::InvalidInput)?,
            )
            .map_err(|_| StoreError::InvalidInput)?;
            if first < now
                && old.as_ref().is_none_or(|r| {
                    r.fields["trigger"]["kind"] != "schedule"
                        || r.fields["trigger"]["startAt"] != trigger["startAt"]
                })
            {
                return Err(StoreError::LoopPolicy(
                    "Choose a first run in the future for a new schedule.",
                ));
            }
        }
        let mut revision = old.as_ref().map_or(0, |r| r.revision);
        if action == "create" {
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM team_loops WHERE team_id=$1 AND deleted_at IS NULL",
            )
            .bind(self.team)
            .fetch_one(&mut *c)
            .await?;
            if count >= 100 {
                return Err(StoreError::LoopPolicy("A team can have up to 100 Loops."));
            }
            revision = 1;
            sqlx::query("INSERT INTO \"user\"(id,name,email,email_verified,created_at,updated_at) VALUES($1,'Forge Loop',$2,false,$3,$3) ON CONFLICT DO NOTHING").bind(contract::principal_id(&id.to_string())).bind(format!("loop-{id}@automation.invalid")).bind(now).execute(&mut *c).await?;
            sqlx::query("INSERT INTO team_loops(id,workspace_id,team_id,fields,revision,enabled) VALUES($1,$2,$3,$4,1,false)").bind(id).bind(&a.workspace_id).bind(self.team).bind(&self.input["fields"]).execute(&mut *c).await?;
        } else {
            let old = old.as_ref().unwrap();
            if action == "run-now" {
                let t = &old.fields["trigger"];
                if t["kind"] == "webhook"
                    || (t["kind"] == "event"
                        && (t["entity"] == "cycle"
                            || matches!(t["event"].as_str(), Some("comment" | "update"))))
                {
                    return Err(StoreError::LoopPolicy(
                        "This trigger does not support Run now.",
                    ));
                }
                let entity = self.input.get("entityId").map(value_id).transpose()?;
                let event = context::manual(c, a, old, entity).await?;
                enqueue(c, old, &format!("manual:{}", self.key), event).await?;
            } else if ["approve", "deny", "cancel-run"].contains(&action) {
                let run:Run=sqlx::query_as("SELECT * FROM loop_runs WHERE id=$1 AND loop_id=$2 AND workspace_id=$3 FOR UPDATE").bind(value_id(&self.input["runId"])?).bind(id).bind(&a.workspace_id).fetch_optional(&mut *c).await?.ok_or(StoreError::Forbidden)?;
                if action == "cancel-run" && run.state == "queued" {
                    sqlx::query(
                        "UPDATE loop_runs SET state='cancelled',finished_at=$1 WHERE id=$2",
                    )
                    .bind(now)
                    .bind(run.id)
                    .execute(&mut *c)
                    .await?;
                } else {
                    if !["running", "waiting-for-approval"].contains(&run.state.as_str())
                        || run.pending_decision.is_some()
                    {
                        return Err(StoreError::LoopPolicy(
                            "This run changed. Refresh its history before continuing.",
                        ));
                    }
                    let mut decision = json!({"action":action,"requestedById":a.user_id});
                    if action != "cancel-run" {
                        let approval:Option<Uuid>=sqlx::query_scalar("SELECT id FROM agent_approvals WHERE id=$1 AND run_id=$2 AND state='pending' AND input_hash=$3 AND expires_at>$4 AND workspace_id=$5 FOR SHARE").bind(value_id(&self.input["approvalId"])?).bind(run.agent_run_id).bind(self.input["inputHash"].as_str()).bind(now).bind(&a.workspace_id).fetch_optional(&mut *c).await?;
                        if approval.is_none() {
                            return Err(StoreError::LoopPolicy(
                                "This approval changed or expired. Refresh the run history.",
                            ));
                        }
                        decision["approvalId"] = self.input["approvalId"].clone();
                        decision["inputHash"] = self.input["inputHash"].clone();
                    }
                    sqlx::query("UPDATE loop_runs SET pending_decision=$1 WHERE id=$2")
                        .bind(decision)
                        .bind(run.id)
                        .execute(&mut *c)
                        .await?;
                }
            } else {
                revision = revision.checked_add(1).ok_or(StoreError::InvalidInput)?;
                if action == "enable"
                    && old.fields["trigger"]["kind"] == "webhook"
                    && old
                        .webhook_secret_hash
                        .as_ref()
                        .is_none_or(|s| s.is_empty())
                {
                    return Err(StoreError::LoopPolicy(
                        "Generate a webhook secret before enabling this Loop.",
                    ));
                }
                if action == "rotate-webhook" && old.fields["trigger"]["kind"] != "webhook" {
                    return Err(StoreError::LoopPolicy(
                        "Only webhook Loops have webhook secrets.",
                    ));
                }
                let fields = if action == "save" {
                    &self.input["fields"]
                } else {
                    &old.fields
                };
                let next = if (action == "enable" || (action == "save" && old.enabled))
                    && fields["trigger"]["kind"] == "schedule"
                {
                    Some(
                        contract::next_scheduled_at(
                            &fields["trigger"],
                            if action == "enable" {
                                now - chrono::Duration::milliseconds(1)
                            } else {
                                now
                            },
                        )
                        .map_err(|_| StoreError::InvalidInput)?,
                    )
                } else {
                    None
                };
                let hash = self
                    .secret
                    .map(|s| format!("{:x}", Sha256::digest(s.as_bytes())));
                sqlx::query("UPDATE team_loops SET revision=$2,updated_at=$3,fields=$4,enabled=CASE WHEN $5='enable' THEN true WHEN $5 IN ('disable','delete') THEN false ELSE enabled END,enabled_by_id=CASE WHEN $5='enable' THEN $6 ELSE enabled_by_id END,enabled_at=CASE WHEN $5='enable' THEN $3 ELSE enabled_at END,next_run_at=CASE WHEN $5 IN ('enable','save','disable','delete') THEN $7 ELSE next_run_at END,deleted_at=CASE WHEN $5='delete' THEN $3 ELSE deleted_at END,webhook_secret_hash=COALESCE($8,webhook_secret_hash) WHERE id=$1").bind(id).bind(revision).bind(now).bind(fields).bind(action).bind(&a.user_id).bind(next).bind(hash).execute(&mut *c).await?;
            }
        }
        if ["disable", "delete"].contains(&action) {
            sqlx::query("UPDATE loop_runs SET state='cancelled',finished_at=$1 WHERE loop_id=$2 AND state='queued'").bind(now).bind(id).execute(&mut *c).await?;
            sqlx::query("UPDATE loop_runs SET pending_decision='{\"action\":\"cancel-run\"}' WHERE loop_id=$1 AND state IN ('running','waiting-for-approval')").bind(id).execute(&mut *c).await?;
        }
        if ["create", "save"].contains(&action) {
            sqlx::query("INSERT INTO loop_revisions(workspace_id,loop_id,revision,fields,author_id) VALUES($1,$2,$3,$4,$5)").bind(&a.workspace_id).bind(id).bind(revision).bind(&self.input["fields"]).bind(&a.user_id).execute(&mut *c).await?;
        }
        let mut event = json!({"loopId":id,"teamId":self.team,"revision":revision});
        if let Some(run) = self.input.get("runId") {
            event["runId"] = run.clone();
            event["requestedById"] = json!(a.user_id);
        }
        if let Some(approval) = self.input.get("approvalId") {
            event["approvalId"] = approval.clone();
        }
        Ok(CommandResult {
            value: Saved { id, revision },
            resource_type: "loop".into(),
            resource_id: id.to_string(),
            events: vec![OutboxEvent {
                topic: format!("loop.{action}"),
                payload: event.as_object().unwrap().clone(),
            }],
        })
    }
}
impl Service {
    pub async fn command(
        &self,
        actor: &Actor,
        team_id: &str,
        key: &str,
        raw: Value,
    ) -> Result<Value, StoreError> {
        let team = id(team_id)?;
        id(key)?;
        let input = contract::command(raw).map_err(|_| StoreError::InvalidInput)?;
        if input["action"] == "enable" {
            self.can_enable(actor).await?;
        }
        let secret = if input["action"] == "rotate-webhook" {
            let server_key = self
                .options
                .environment
                .get("FORGE_LOOP_WEBHOOK_SECRET")
                .filter(|s| s.encode_utf16().count() >= 32)
                .ok_or(StoreError::LoopPolicy(
                    "Webhook secret generation is not configured.",
                ))?;
            let mut mac = Hmac::<Sha256>::new_from_slice(server_key.as_bytes())
                .map_err(|_| StoreError::InvalidInput)?;
            mac.update(format!("{}:{key}", input["id"].as_str().unwrap()).as_bytes());
            Some(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
        } else {
            None
        };
        let mut body = input.clone();
        body["teamId"] = json!(team);
        let result = commands::execute(
            &self.database,
            actor,
            Command {
                key,
                operation: "loops.write@1",
                input: &body,
                status: 200,
            },
            &Mutation {
                service: self,
                team,
                key,
                input: &input,
                secret: secret.as_deref(),
            },
        )
        .await;
        match result {
            Ok(saved) => {
                let mut result =
                    json!({"status":"saved","id":saved.value.id,"revision":saved.value.revision});
                if let Some(secret) = secret {
                    result["webhookSecret"] = json!(secret);
                }
                Ok(result)
            }
            Err(StoreError::LoopConflict) => {
                let directory = self.read(actor, team_id).await?;
                let current = directory["loops"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|r| r["id"] == input["id"])
                    .cloned();
                Ok(json!({"status":"conflict","current":current}))
            }
            Err(e) => Err(e),
        }
    }
}
