use super::*;
use chrono::Duration;
#[derive(FromRow)]
struct Trial {
    workspace_id: String,
    id: Uuid,
    initial_plan: String,
    actor_user_id: Option<String>,
    start_request_id: Uuid,
    start_body_hash: String,
    started_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    allowance_usd_micros: i64,
}
impl Trial {
    fn value(&self) -> Value {
        json!({"workspaceId":self.workspace_id,"id":self.id,"initialPlan":self.initial_plan,
            "actorUserId":self.actor_user_id,"startRequestId":self.start_request_id,
            "startBodyHash":self.start_body_hash,"startedAt":stamp(self.started_at),
            "expiresAt":stamp(self.expires_at),"allowanceUsdMicros":self.allowance_usd_micros})
    }
}
impl Service {
    /// Internal command; the public trial action remains gated like its source.
    pub async fn start_trial(&self, actor: &Actor, input: Value) -> Result<Value, StoreError> {
        policy::identity(actor)?;
        fields(&input, &["requestId", "plan"])?;
        let request = id(&input["requestId"])?;
        let plan = policy::schema("selfServePlan", input["plan"].clone())?;
        let body_hash = hash(
            &json!({"workspaceId":actor.workspace_id,"actorUserId":actor.user_id,
            "requestId":input["requestId"],"plan":plan}),
        );
        let mut tx = self.database.begin().await?;
        sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
            .bind(&actor.workspace_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| fail("TRIAL_WORKSPACE_NOT_FOUND"))?;
        live(&mut tx, actor, true).await?;
        let prior: Option<Trial> =
            sqlx::query_as("SELECT * FROM workspace_trial_redemptions WHERE workspace_id=$1")
                .bind(&actor.workspace_id)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(prior) = prior {
            // PostgreSQL returns the canonical spelling, while the source's
            // input/hash preserve caller spelling; do not normalize the hash.
            if prior.start_request_id.to_string() == text(&input["requestId"])?
                && prior.start_body_hash != body_hash
            {
                return Err(fail("TRIAL_REQUEST_CONFLICT"));
            }
            if prior.initial_plan != text(&plan)? {
                return Err(fail("TRIAL_TIER_LOCKED"));
            }
            tx.commit().await?;
            return Ok(json!({"trial":prior.value(),"replayed":true}));
        }
        let state = state(&mut tx, &actor.workspace_id).await?;
        if !state.is_null()
            && (state["source"] != "internal"
                || state["plan"] != "free"
                || state["status"] != "active"
                || state["sourceReference"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
                || !state["paidActivatedAt"].is_null()
                || state["refundedPeriods"]
                    .as_array()
                    .is_none_or(|a| !a.is_empty())
                || state["providerEnvironment"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
                || !state["terminatedAt"].is_null()
                || !state["trialRedemptionId"].is_null())
        {
            return Err(fail("TRIAL_NEVER_PAID_REQUIRED"));
        }
        let start = now();
        let end = start + Duration::days(14);
        tx.prepare().await?;
        let trial: Trial = sqlx::query_as("INSERT INTO workspace_trial_redemptions(workspace_id,initial_plan,actor_user_id,start_request_id,start_body_hash,started_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *")
            .bind(&actor.workspace_id).bind(text(&plan)?).bind(&actor.user_id).bind(request).bind(body_hash).bind(start).bind(end).fetch_one(&mut *tx).await?;
        sqlx::query("INSERT INTO workspace_entitlements(workspace_id,plan,status,source,source_reference,trial_redemption_id,current_period_start,current_period_end,updated_at,feature_overrides) VALUES($1,$2,'trialing','forge-trial',$3::uuid::text,$3,$4,$5,$4,'{}') ON CONFLICT(workspace_id) DO UPDATE SET plan=EXCLUDED.plan,status=EXCLUDED.status,source=EXCLUDED.source,source_reference=EXCLUDED.source_reference,trial_redemption_id=EXCLUDED.trial_redemption_id,current_period_start=EXCLUDED.current_period_start,current_period_end=EXCLUDED.current_period_end,updated_at=EXCLUDED.updated_at,feature_overrides=EXCLUDED.feature_overrides")
            .bind(&actor.workspace_id).bind(if plan == "starter" { "basic" } else { "business" }).bind(trial.id).bind(start).bind(end).execute(&mut *tx).await?;
        audit(&mut tx, &actor.workspace_id, Some(&actor.user_id), "billing.trial.started", &trial.id.to_string(),
            &format!("forge.trial-start.{}",text(&input["requestId"])?),
            json!({"plan":trial.initial_plan,"startedAt":stamp(start),"expiresAt":stamp(end),"allowanceUsdMicros":5_000_000})).await?;
        tx.commit().await?;
        Ok(json!({"trial":trial.value(),"replayed":false}))
    }
    /// Cleanup only; access expiry never depends on this method being called.
    pub async fn expire_trial(&self, workspace: &str) -> Result<Value, StoreError> {
        let mut tx = self.database.begin().await?;
        sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
            .bind(workspace)
            .fetch_optional(&mut *tx)
            .await?;
        let trial: Option<Trial> =
            sqlx::query_as("SELECT * FROM workspace_trial_redemptions WHERE workspace_id=$1")
                .bind(workspace)
                .fetch_optional(&mut *tx)
                .await?;
        let at = now();
        let Some(trial) = trial.filter(|t| t.expires_at <= at) else {
            tx.commit().await?;
            return Ok(json!({"expired":false}));
        };
        let eligible: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workspace_entitlements WHERE workspace_id=$1 AND source='forge-trial' AND trial_redemption_id=$2 AND status='trialing')")
            .bind(workspace).bind(trial.id).fetch_one(&mut *tx).await?;
        if !eligible {
            tx.commit().await?;
            return Ok(json!({"expired":false}));
        }
        tx.prepare().await?;
        let changed = sqlx::query("UPDATE workspace_entitlements SET plan='free',status='canceled',updated_at=$3 WHERE workspace_id=$1 AND source='forge-trial' AND trial_redemption_id=$2 AND status='trialing'")
            .bind(workspace).bind(trial.id).bind(at).execute(&mut *tx).await?.rows_affected() > 0;
        if changed {
            audit(&mut tx, workspace, None, "billing.trial.expired", &trial.id.to_string(), &format!("forge.trial-expiry.{}",trial.id),
                json!({"plan":"free","originalExpiresAt":stamp(trial.expires_at),"grantsNewAllowance":false})).await?;
        }
        tx.commit().await?;
        Ok(json!({"expired":changed}))
    }
}
