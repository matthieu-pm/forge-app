use super::projection::{execute_commands, normalize_dates, normalized_state};
use super::*;
use policy::{
    management::{self as rules, ManagementContext, Prepared},
    projection::Context,
};

async fn membership(c: &mut PgConnection, actor: &Actor) -> Result<Option<String>, StoreError> {
    Ok(sqlx::query_scalar(
        "SELECT role FROM member WHERE organization_id=$1 AND user_id=$2 FOR SHARE",
    )
    .bind(&actor.workspace_id)
    .bind(&actor.user_id)
    .fetch_optional(c)
    .await?)
}
async fn capacity(c: &mut PgConnection, workspace: &str) -> Result<Value, StoreError> {
    Ok(sqlx::query_scalar("SELECT jsonb_build_object('activeMemberCount',active_member_count) FROM workspace_member_capacity WHERE workspace_id=$1 FOR SHARE").bind(workspace).fetch_optional(c).await?.unwrap_or(Value::Null))
}
fn request_row(raw: Option<Value>) -> Result<Value, StoreError> {
    let mut value = raw.map(camel_columns).unwrap_or(Value::Null);
    normalize_dates(
        &mut value,
        &[
            "effectiveAt",
            "originalPeriodStart",
            "nextRenewalAt",
            "checkoutGraceEndsAt",
            "requestedAt",
            "updatedAt",
        ],
    )?;
    Ok(value)
}
impl Service {
    pub async fn count_billable_members(&self, actor: &Actor) -> Result<u64, StoreError> {
        policy::identity(actor)?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM member WHERE organization_id=$1")
            .bind(&actor.workspace_id)
            .fetch_one(self.database.pool())
            .await?;
        Ok(policy::safe_integer(&json!(count), 1)?)
    }
    pub async fn cancellation_context(
        &self,
        actor: &Actor,
        environment: &str,
    ) -> Result<Value, StoreError> {
        policy::identity(actor)?;
        let mut tx = self.database.begin().await?;
        let role = membership(&mut tx, actor).await?;
        let state = normalized_state(&mut tx, &actor.workspace_id).await?;
        let result = rules::cancellation_context(actor, environment, role.as_deref(), &state)?;
        tx.commit().await?;
        Ok(result)
    }
    pub async fn plan_change_context(
        &self,
        actor: &Actor,
        environment: &str,
    ) -> Result<Value, StoreError> {
        policy::identity(actor)?;
        let mut tx = self.database.begin().await?;
        let role = membership(&mut tx, actor).await?;
        let state = normalized_state(&mut tx, &actor.workspace_id).await?;
        let capacity = capacity(&mut tx, &actor.workspace_id).await?;
        let result = rules::plan_change_context(
            actor,
            environment,
            role.as_deref(),
            &state,
            &capacity,
            now(),
        )?;
        tx.commit().await?;
        Ok(result)
    }
    pub async fn upgrade_refund_renewal_context(&self, input: Value) -> Result<Value, StoreError> {
        let input = rules::refund_identity(&input)?;
        let mut connection = self.database.pool().acquire().await?;
        let state = normalized_state(&mut connection, text(&input["workspaceId"])?).await?;
        Ok(rules::refund_renewal_context(&input, &state)?)
    }
    /// Server-verified billing country/binding only. This records an intent;
    /// provider scheduling and replacement proof remain separate gated adapters.
    pub async fn record_renewal_currency_request(
        &self,
        actor: &Actor,
        input: Value,
    ) -> Result<Value, StoreError> {
        let prepared = Prepared::currency(actor, &input)?;
        self.apply_management(prepared, input.get("requestId"))
            .await
    }
    pub async fn confirm_upgrade_refund_renewal(
        &self,
        input: Value,
        proof: Value,
    ) -> Result<Value, StoreError> {
        self.apply_management(Prepared::refund_renewal(&input, &proof)?, None)
            .await
    }
    async fn apply_management(
        &self,
        p: Prepared,
        request_id: Option<&Value>,
    ) -> Result<Value, StoreError> {
        let mut tx = self.database.begin().await?;
        sqlx::query("SELECT id FROM organization WHERE id=$1 FOR NO KEY UPDATE")
            .bind(&p.workspace)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| fail("BILLING_WORKSPACE_NOT_FOUND"))?;
        let role = if let Some(actor) = &p.actor {
            membership(&mut tx, actor).await?
        } else {
            None
        };
        let previous = normalized_state(&mut tx, &p.workspace).await?;
        let receipt=sqlx::query_scalar("SELECT jsonb_build_object('workspaceId',workspace_id,'environment',environment,'eventId',event_id,'bodyHash',body_hash,'subscriptionId',subscription_id,'outcome',outcome) FROM billing_event_receipts WHERE environment=$1 AND event_id=$2").bind(&p.environment).bind(&p.event_id).fetch_optional(&mut *tx).await?.unwrap_or(Value::Null);
        let (requested, pending, capacity) = if let Some(key) = request_id {
            let requested = request_row(
                sqlx::query_scalar(
                    "SELECT to_jsonb(r) FROM workspace_currency_change_requests r WHERE id=$1",
                )
                .bind(id(key)?)
                .fetch_optional(&mut *tx)
                .await?,
            )?;
            let pending=request_row(sqlx::query_scalar("SELECT to_jsonb(r) FROM workspace_currency_change_requests r WHERE workspace_id=$1 AND state='requested'").bind(&p.workspace).fetch_optional(&mut *tx).await?)?;
            (requested, pending, capacity(&mut tx, &p.workspace).await?)
        } else {
            (Value::Null, Value::Null, Value::Null)
        };
        let plan = p.plan(&ManagementContext {
            base: Context {
                previous,
                receipt,
                member_role: role,
                workspace_exists: true,
                now: now(),
            },
            requested,
            pending,
            capacity,
        })?;
        if !plan.commands.is_empty() {
            tx.prepare().await?;
        }
        execute_commands(
            &mut tx,
            &p.workspace,
            &p.environment,
            &p.event_id,
            plan.commands,
        )
        .await?;
        tx.commit().await?;
        Ok(plan.answer)
    }
}
