//! Token-free input intents and the app-drained execution handoff. All ordering
//! uses the conversation lock; acceptance never alters an active worker's epoch.
use super::conversation::{
    Conversation, lock_conversation, lock_owner, next_generation, parent_state,
};
use super::*;
use forge_core::agents::runtime::{
    ConversationFence, DeliveryPhase, DeliveryReceipt, DeliverySnapshot, DrainBoundary,
    HandoffAuthority, HandoffPlan, IntentReceipt, IntentState, Preparation, QueuedInput,
};

pub(super) fn authority(channel: &Channel) -> HandoffAuthority {
    HandoffAuthority {
        provider: channel.provider().into(),
        model_id: channel.model_id().into(),
        reasoning_effort: channel.reasoning_effort().into(),
    }
}
pub(super) fn verify_authority(row: &Row, channel: &Channel) -> Result<()> {
    let saved: HandoffAuthority =
        serde_json::from_str(row.authority.as_deref().ok_or(INVALID)?).map_err(|_| INVALID)?;
    if saved != authority(channel) {
        return Err(INVALID);
    }
    restored(row, channel)?;
    Ok(())
}
pub(super) fn snapshot_sql(alias: &str) -> String {
    format!(
        "jsonb_build_object('runId',{alias}.run_id,'inputGeneration',{alias}.input_generation,'stateRevision',{alias}.revision,'nextIndex',{alias}.next_index,'phase',{alias}.engine_state->>'phase','cancelled',{alias}.cancelled_at IS NOT NULL,'deliveryOnly',{alias}.delivery_only)::text"
    )
}
fn snapshot(row: &Row) -> Result<DeliverySnapshot> {
    let phase: DeliveryPhase = serde_json::from_value(
        forge_core::json::parse(&row.snapshot).map_err(|_| INVALID)?["phase"].clone(),
    )
    .map_err(|_| INVALID)?;
    Ok(DeliverySnapshot {
        run_id: row.run_id,
        input_generation: row.input_generation as u64,
        state_revision: row.revision as u64,
        next_index: row.next_index as u64,
        phase,
        cancelled: row.cancelled_at.is_some(),
        delivery_only: row.delivery_only,
    })
}
fn fence(id: Uuid, head: &Conversation) -> Result<ConversationFence> {
    Ok(ConversationFence {
        conversation_id: id,
        head_run_id: head.last_run_id.ok_or(INVALID)?,
        generation: head.generation as u64,
    })
}
async fn delivery_row(
    connection: &mut PgConnection,
    id: Uuid,
    conversation: Uuid,
    channel: &Channel,
) -> Result<Row> {
    let row: Row = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM forge_runtime.sessions WHERE run_id=$1 FOR UPDATE"
    ))
    .bind(id)
    .fetch_optional(connection)
    .await
    .map_err(|_| FAILED)?
    .ok_or(INVALID)?;
    scoped(&row, channel)?;
    if row.conversation_id != Some(conversation) {
        return Err(INVALID);
    }
    Ok(row)
}
async fn boundary(
    connection: &mut PgConnection,
    id: Uuid,
    head: &Conversation,
    channel: &Channel,
) -> Result<(DrainBoundary, Row, Row)> {
    let delivery = delivery_row(
        connection,
        head.current_delivery_run_id.ok_or(INVALID)?,
        id,
        channel,
    )
    .await?;
    let execution = lock_owner(
        connection,
        head.execution_run_id.ok_or(INVALID)?,
        id,
        channel,
    )
    .await?;
    Ok((
        DrainBoundary {
            conversation: fence(id, head)?,
            delivery: snapshot(&delivery)?,
            execution: snapshot(&execution)?,
        },
        delivery,
        execution,
    ))
}
fn parked(snapshot: &DeliverySnapshot) -> bool {
    snapshot.cancelled
        || matches!(
            snapshot.phase,
            DeliveryPhase::Waiting
                | DeliveryPhase::Complete
                | DeliveryPhase::Cancelled
                | DeliveryPhase::Failed
        )
}
fn drained(head: &Conversation, boundary: &DrainBoundary) -> bool {
    head.drained_boundary
        .as_deref()
        .and_then(|value| serde_json::from_str::<DrainBoundary>(value).ok())
        .as_ref()
        == Some(boundary)
}
pub(super) async fn admission_barrier(
    connection: &mut PgConnection,
    id: Uuid,
    head: &Conversation,
    channel: &Channel,
) -> Result<()> {
    let queued: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM forge_runtime.input_intents WHERE conversation_id=$1 AND state IN ('queued','prepared'))")
        .bind(id).fetch_one(&mut *connection).await.map_err(|_| FAILED)?;
    if queued {
        return Err(BUSY);
    }
    let (current, _, _) = boundary(connection, id, head, channel).await?;
    if !parked(&current.delivery) || !parked(&current.execution) || !drained(head, &current) {
        return Err(BUSY);
    }
    Ok(())
}
#[derive(sqlx::FromRow)]
struct Intent {
    intent_id: Uuid,
    conversation_id: Uuid,
    sequence: i64,
    original_run_id: Uuid,
    request_id: Uuid,
    approved: bool,
    authority: String,
    state: String,
    handoff_id: Option<Uuid>,
}
const INTENT_COLUMNS: &str = "intent_id,conversation_id,sequence,original_run_id,request_id,approved,authority::text AS authority,state,handoff_id";
#[derive(sqlx::FromRow)]
struct PlanRow {
    id: Uuid,
    plan: String,
    state: String,
    receipt: Option<String>,
}
impl PlanRow {
    fn parsed(&self) -> Result<HandoffPlan> {
        serde_json::from_str(&self.plan).map_err(|_| FAILED)
    }
}
async fn receipt(
    connection: &mut PgConnection,
    intent: &Intent,
    head: &Conversation,
    replayed: bool,
) -> Result<IntentReceipt> {
    let activation = if let Some(id) = intent.handoff_id {
        let value: Option<String> = sqlx::query_scalar(
            "SELECT receipt::text FROM forge_runtime.input_handoffs WHERE id=$1",
        )
        .bind(id)
        .fetch_one(connection)
        .await
        .map_err(|_| FAILED)?;
        value
            .map(|value| serde_json::from_str::<DeliveryReceipt>(&value).map_err(|_| FAILED))
            .transpose()?
    } else {
        None
    };
    let state = match intent.state.as_str() {
        "queued" => IntentState::Queued,
        "prepared" => IntentState::Prepared,
        "activated" => IntentState::Activated,
        "cancelled" => IntentState::Cancelled,
        "expired" => IntentState::Expired,
        _ => return Err(FAILED),
    };
    Ok(IntentReceipt {
        intent_id: intent.intent_id,
        sequence: intent.sequence as u64,
        original_run_id: intent.original_run_id,
        request_id: intent.request_id,
        approved: intent.approved,
        state,
        handoff_id: intent.handoff_id,
        activation_run_id: activation.as_ref().map(|value| value.run_id),
        stream_start_index: activation.as_ref().map(|value| value.stream_start_index),
        replayed,
        conversation: fence(intent.conversation_id, head)?,
    })
}
async fn intents(connection: &mut PgConnection, id: Uuid, state: &str) -> Result<Vec<Intent>> {
    sqlx::query_as(&format!("SELECT {INTENT_COLUMNS} FROM forge_runtime.input_intents WHERE conversation_id=$1 AND state=$2 ORDER BY sequence FOR UPDATE"))
        .bind(id).bind(state).fetch_all(connection).await.map_err(|_| FAILED)
}
fn invalid_origin(row: &Row, at: DateTime<Utc>) -> Option<&'static str> {
    if row.cancelled_at.is_some()
        || forge_core::json::parse(&row.snapshot)
            .ok()
            .is_some_and(|state| matches!(state["phase"].as_str(), Some("failed" | "cancelled")))
    {
        Some("cancelled")
    } else if row.deadline <= at {
        Some("expired")
    } else {
        None
    }
}
async fn qualify(
    connection: &mut PgConnection,
    intent: &Intent,
    channel: &Channel,
    at: DateTime<Utc>,
) -> Result<bool> {
    let row = delivery_row(
        connection,
        intent.original_run_id,
        intent.conversation_id,
        channel,
    )
    .await?;
    if let Some(disposition) = invalid_origin(&row, at) {
        sqlx::query("UPDATE forge_runtime.input_intents SET state=$2 WHERE intent_id=$1")
            .bind(intent.intent_id)
            .bind(disposition)
            .execute(connection)
            .await
            .map_err(|_| FAILED)?;
        return Ok(false);
    }
    let state = parent_state(&row, channel)?;
    if row.delivery_only
        || state
            .issued_request(&intent.request_id.to_string())
            .is_none()
        || row
            .authority
            .as_deref()
            .and_then(|value| serde_json::from_str::<HandoffAuthority>(value).ok())
            != Some(serde_json::from_str(&intent.authority).map_err(|_| FAILED)?)
    {
        return Err(INVALID);
    }
    Ok(true)
}
async fn invalidate(connection: &mut PgConnection, id: Uuid) -> Result<()> {
    sqlx::query("UPDATE forge_runtime.input_handoffs SET state='invalidated' WHERE id=$1 AND state='prepared'").bind(id).execute(&mut *connection).await.map_err(|_|FAILED)?;
    sqlx::query("UPDATE forge_runtime.input_intents SET state='queued',handoff_id=NULL WHERE handoff_id=$1 AND state='prepared'").bind(id).execute(connection).await.map_err(|_|FAILED)?;
    Ok(())
}
impl Store {
    pub async fn enqueue_input(
        &self,
        channel: &Channel,
        input: &QueuedInput,
    ) -> Result<IntentReceipt> {
        let mut tx = self.pool.begin().await.map_err(|_| FAILED)?;
        let head = lock_conversation(&mut tx, input.conversation_id, channel).await?;
        if !head.managed {
            return Err(INVALID);
        }
        let original = delivery_row(&mut tx, run(channel)?, input.conversation_id, channel).await?;
        verify_authority(&original, channel)?;
        let original_state = parent_state(&original, channel)?;
        if original.delivery_only
            || original_state
                .issued_request(&input.request_id.to_string())
                .is_none()
        {
            return Err(INVALID);
        }
        let existing:Vec<Intent>=sqlx::query_as(&format!("SELECT {INTENT_COLUMNS} FROM forge_runtime.input_intents WHERE intent_id=$1 OR (original_run_id=$2 AND request_id=$3) FOR UPDATE"))
            .bind(input.intent_id).bind(original.run_id).bind(input.request_id).fetch_all(&mut *tx).await.map_err(|_|FAILED)?;
        if let Some(intent) = existing.first() {
            if existing.len() != 1
                || intent.intent_id != input.intent_id
                || intent.original_run_id != original.run_id
                || intent.conversation_id != input.conversation_id
                || intent.request_id != input.request_id
                || intent.approved != input.approved
            {
                return Err(INVALID);
            }
            let receipt = receipt(&mut tx, intent, &head, true).await?;
            tx.commit().await.map_err(|_| FAILED)?;
            return Ok(receipt);
        }
        if invalid_origin(&original, now(&mut tx).await?).is_some() {
            return Err(LOST);
        }
        let already:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM forge_runtime.input_deliveries WHERE run_id=$1 AND request_id=$2)").bind(original.run_id).bind(input.request_id).fetch_one(&mut *tx).await.map_err(|_|FAILED)?;
        if already
            || original_state
                .decision(&input.request_id.to_string())
                .is_some()
        {
            return Err(INVALID);
        }
        let count:i64=sqlx::query_scalar("SELECT count(*) FROM forge_runtime.input_intents WHERE conversation_id=$1 AND state IN ('queued','prepared')").bind(input.conversation_id).fetch_one(&mut *tx).await.map_err(|_|FAILED)?;
        if count >= 128 {
            return Err(BUSY);
        }
        let sequence = next_generation(head.intent_sequence)?;
        sqlx::query("INSERT INTO forge_runtime.input_intents(intent_id,conversation_id,sequence,original_run_id,request_id,approved,authority,state) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'queued')")
            .bind(input.intent_id).bind(input.conversation_id).bind(sequence).bind(original.run_id).bind(input.request_id).bind(input.approved).bind(original.authority.as_deref().ok_or(INVALID)?).execute(&mut *tx).await.map_err(|_|FAILED)?;
        sqlx::query("UPDATE forge_runtime.conversations SET intent_sequence=$2 WHERE id=$1")
            .bind(input.conversation_id)
            .bind(sequence)
            .execute(&mut *tx)
            .await
            .map_err(|_| FAILED)?;
        let intent = Intent {
            intent_id: input.intent_id,
            conversation_id: input.conversation_id,
            sequence,
            original_run_id: original.run_id,
            request_id: input.request_id,
            approved: input.approved,
            authority: original.authority.ok_or(INVALID)?,
            state: "queued".into(),
            handoff_id: None,
        };
        let receipt = receipt(&mut tx, &intent, &head, false).await?;
        tx.commit().await.map_err(|_| FAILED)?;
        Ok(receipt)
    }
    pub async fn acknowledge_drained(
        &self,
        channel: &Channel,
        expected: &DrainBoundary,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await.map_err(|_| FAILED)?;
        let id = expected.conversation.conversation_id;
        let head = lock_conversation(&mut tx, id, channel).await?;
        let (current, delivery, _) = boundary(&mut tx, id, &head, channel).await?;
        if !head.managed
            || run(channel)? != delivery.run_id
            || current != *expected
            || !parked(&current.delivery)
            || !parked(&current.execution)
        {
            return Err(INVALID);
        }
        verify_authority(&delivery, channel)?;
        sqlx::query(
            "UPDATE forge_runtime.conversations SET drained_boundary=$2::jsonb WHERE id=$1",
        )
        .bind(id)
        .bind(javascript_stringify(&json!(current)))
        .execute(&mut *tx)
        .await
        .map_err(|_| FAILED)?;
        tx.commit().await.map_err(|_| FAILED)
    }
    pub async fn prepare_handoff(
        &self,
        channel: &Channel,
        expected: &ConversationFence,
    ) -> Result<Preparation> {
        let mut tx = self.pool.begin().await.map_err(|_| FAILED)?;
        let id = expected.conversation_id;
        let head = lock_conversation(&mut tx, id, channel).await?;
        if !head.managed || fence(id, &head)? != *expected {
            return Err(INVALID);
        }
        let (current, _, _) = boundary(&mut tx, id, &head, channel).await?;
        let existing:Option<PlanRow>=sqlx::query_as("SELECT id,plan::text AS plan,state,receipt::text AS receipt FROM forge_runtime.input_handoffs WHERE conversation_id=$1 AND state='prepared' FOR UPDATE").bind(id).fetch_optional(&mut *tx).await.map_err(|_|FAILED)?;
        let at = now(&mut tx).await?;
        if let Some(existing) = existing {
            let plan = existing.parsed()?;
            let mut valid = plan.boundary == current && drained(&head, &current);
            for intent in intents(&mut tx, id, "prepared").await? {
                valid &= qualify(&mut tx, &intent, channel, at).await?;
            }
            if valid {
                tx.commit().await.map_err(|_| FAILED)?;
                return Ok(Preparation::Ready { plan });
            }
            invalidate(&mut tx, existing.id).await?;
        }
        let mut pending = vec![];
        for intent in intents(&mut tx, id, "queued").await? {
            if qualify(&mut tx, &intent, channel, at).await? {
                pending.push(intent);
            }
        }
        if pending.is_empty() {
            tx.commit().await.map_err(|_| FAILED)?;
            return Ok(Preparation::Empty);
        }
        if !parked(&current.delivery) || !parked(&current.execution) || !drained(&head, &current) {
            tx.commit().await.map_err(|_| FAILED)?;
            return Ok(Preparation::AwaitingDrain);
        }
        let last = pending.last().ok_or(INVALID)?;
        let deliveries=pending.iter().map(|intent| Ok(json!({"requestId":intent.intent_id,"payloads":[{"inputResponses":[{"requestId":intent.request_id,"optionId":if intent.approved {"approve"} else {"deny"}}]}],"auth":{"runId":intent.original_run_id,"selection":serde_json::from_str::<HandoffAuthority>(&intent.authority).map_err(|_|FAILED)?}}))).collect::<Result<Vec<_>>>()?;
        let coalesced =
            forge_core::agents::delivery::coalesce_deliveries(&deliveries).map_err(|_| INVALID)?;
        let anchor: Uuid =
            serde_json::from_value(coalesced["requestId"].clone()).map_err(|_| INVALID)?;
        let activation: Uuid =
            serde_json::from_value(coalesced["auth"]["runId"].clone()).map_err(|_| INVALID)?;
        let selected: HandoffAuthority =
            serde_json::from_value(coalesced["auth"]["selection"].clone()).map_err(|_| INVALID)?;
        let plan = HandoffPlan {
            id: Uuid::new_v4(),
            conversation: fence(id, &head)?,
            anchor_intent_id: anchor,
            intent_ids: pending.iter().map(|intent| intent.intent_id).collect(),
            prefix_end_sequence: last.sequence as u64,
            activation_run_id: activation,
            authority: selected,
            boundary: current,
        };
        sqlx::query("INSERT INTO forge_runtime.input_handoffs(id,conversation_id,plan,state) VALUES($1,$2,$3::jsonb,'prepared')").bind(plan.id).bind(id).bind(javascript_stringify(&json!(plan))).execute(&mut *tx).await.map_err(|_|FAILED)?;
        sqlx::query("UPDATE forge_runtime.input_intents SET state='prepared',handoff_id=$2 WHERE conversation_id=$1 AND state='queued' AND sequence<=$3").bind(id).bind(plan.id).bind(last.sequence).execute(&mut *tx).await.map_err(|_|FAILED)?;
        tx.commit().await.map_err(|_| FAILED)?;
        Ok(Preparation::Ready { plan })
    }
    pub async fn activate_handoff(
        &self,
        channel: &Channel,
        id: Uuid,
        expected: &DrainBoundary,
    ) -> Result<DeliveryReceipt> {
        let mut tx = self.pool.begin().await.map_err(|_| FAILED)?;
        let conversation_id = expected.conversation.conversation_id;
        let head = lock_conversation(&mut tx, conversation_id, channel).await?;
        if !head.managed {
            return Err(INVALID);
        }
        let saved:PlanRow=sqlx::query_as("SELECT id,plan::text AS plan,state,receipt::text AS receipt FROM forge_runtime.input_handoffs WHERE id=$1 AND conversation_id=$2 FOR UPDATE").bind(id).bind(conversation_id).fetch_optional(&mut *tx).await.map_err(|_|FAILED)?.ok_or(INVALID)?;
        let plan = saved.parsed()?;
        if plan.boundary != *expected
            || plan.activation_run_id != run(channel)?
            || plan.authority != authority(channel)
        {
            return Err(INVALID);
        }
        if saved.state == "activated" {
            let mut receipt: DeliveryReceipt =
                serde_json::from_str(saved.receipt.as_deref().ok_or(FAILED)?)
                    .map_err(|_| FAILED)?;
            let original =
                delivery_row(&mut tx, plan.activation_run_id, conversation_id, channel).await?;
            verify_authority(&original, channel)?;
            receipt.replayed = true;
            receipt.current_delivery = head.current_delivery_run_id == Some(receipt.run_id)
                && head.generation as u64 == receipt.input_generation
                && original.input_generation as u64 == receipt.input_generation
                && original.cancelled_at.is_none();
            tx.commit().await.map_err(|_| FAILED)?;
            return Ok(receipt);
        }
        if saved.state != "prepared" {
            return Err(LOST);
        }
        let (current, delivery, owner) = boundary(&mut tx, conversation_id, &head, channel).await?;
        let pending = intents(&mut tx, conversation_id, "prepared").await?;
        let mut valid = current == plan.boundary
            && drained(&head, &current)
            && parked(&current.delivery)
            && parked(&current.execution)
            && pending
                .iter()
                .map(|intent| intent.intent_id)
                .collect::<Vec<_>>()
                == plan.intent_ids;
        let at = now(&mut tx).await?;
        for intent in &pending {
            valid &= qualify(&mut tx, intent, channel, at).await?;
        }
        if !valid {
            invalidate(&mut tx, id).await?;
            tx.commit().await.map_err(|_| FAILED)?;
            return Err(LOST);
        }
        let original =
            delivery_row(&mut tx, plan.activation_run_id, conversation_id, channel).await?;
        verify_authority(&original, channel)?;
        let original_state = parent_state(&original, channel)?;
        let mut owner_state = parent_state(&owner, channel)?;
        if owner.cancelled_at.is_some()
            || matches!(owner_state.phase(), Phase::Cancelled | Phase::Failed)
        {
            let mut retained = vec![];
            for request in owner_state
                .pending_requests()
                .into_iter()
                .filter(|request| request["kind"] == "tool-approval")
            {
                let request_id = request["requestId"].as_str().ok_or(INVALID)?;
                let candidates:Vec<Uuid>=sqlx::query_scalar("SELECT run_id FROM forge_runtime.sessions WHERE conversation_id=$1 AND run_id<>$2 AND engine_state->'issued_requests' ? $3 ORDER BY run_id")
                    .bind(conversation_id).bind(owner.run_id).bind(request_id).fetch_all(&mut *tx).await.map_err(|_|FAILED)?;
                if candidates.len() == 1 {
                    let origin =
                        delivery_row(&mut tx, candidates[0], conversation_id, channel).await?;
                    if invalid_origin(&origin, at).is_none()
                        && parent_state(&origin, channel)?.issued_request(request_id)
                            == Some(&request)
                    {
                        retained.push(request_id.into());
                    }
                }
            }
            owner_state = owner_state.settle_cancelled_inputs(&retained)?;
        }
        let responses=pending.iter().map(|intent|json!({"requestId":intent.request_id,"optionId":if intent.approved {"approve"}else{"deny"}})).collect::<Vec<_>>();
        let mut earlier_limits = vec![];
        for intent in &pending {
            let origin =
                delivery_row(&mut tx, intent.original_run_id, conversation_id, channel).await?;
            if parent_state(&origin, channel)?
                .issued_request(&intent.request_id.to_string())
                .is_some_and(|request| request["kind"] == "session-limit")
            {
                earlier_limits.push(intent.request_id.to_string());
            }
        }
        let (next, events) = owner_state.canonical_inputs_with_limits(
            channel,
            &original_state,
            &responses,
            &earlier_limits,
        )?;
        let text = javascript_stringify(&next.snapshot());
        if text.len() > LIMIT {
            return Err(INVALID);
        }
        let at_commit = now(&mut tx).await?;
        let mut eligible = true;
        for intent in &pending {
            eligible &= qualify(&mut tx, intent, channel, at_commit).await?;
        }
        if !eligible {
            invalidate(&mut tx, id).await?;
            tx.commit().await.map_err(|_| FAILED)?;
            return Err(LOST);
        }
        let generation = next_generation(head.generation)?;
        sqlx::query("UPDATE forge_runtime.sessions SET revision=$2,engine_state=$3::jsonb,epoch=$4,lease_owner=NULL,lease_until=NULL,continued_by_run_id=NULL,input_generation=$5,updated_at=$6 WHERE run_id=$1")
            .bind(original.run_id).bind(next.revision() as i64).bind(text).bind(original.epoch.checked_add(1).ok_or(LOST)?).bind(generation).bind(at).execute(&mut *tx).await.map_err(|_|FAILED)?;
        append(&mut tx, channel, &original, &events, at, false).await?;
        let mut fenced = std::collections::HashSet::new();
        for prior in [&owner, &delivery] {
            if prior.run_id != original.run_id && fenced.insert(prior.run_id) {
                sqlx::query("UPDATE forge_runtime.sessions SET continued_by_run_id=$2,epoch=epoch+1,lease_owner=NULL,lease_until=NULL,updated_at=$3 WHERE run_id=$1").bind(prior.run_id).bind(original.run_id).bind(at).execute(&mut *tx).await.map_err(|_|FAILED)?;
            }
        }
        sqlx::query("UPDATE forge_runtime.conversations SET execution_run_id=$2,current_delivery_run_id=$2,generation=$3,drained_boundary=NULL,updated_at=$4 WHERE id=$1").bind(conversation_id).bind(original.run_id).bind(generation).bind(at).execute(&mut *tx).await.map_err(|_|FAILED)?;
        let receipt = DeliveryReceipt {
            run_id: original.run_id,
            input_generation: generation as u64,
            stream_start_index: original.next_index as u64,
            current_delivery: true,
            replayed: false,
            handoff_id: Some(id),
        };
        sqlx::query("UPDATE forge_runtime.input_handoffs SET state='activated',receipt=$2::jsonb WHERE id=$1").bind(id).bind(javascript_stringify(&json!(receipt))).execute(&mut *tx).await.map_err(|_|FAILED)?;
        for intent in pending {
            sqlx::query("INSERT INTO forge_runtime.input_deliveries(run_id,request_id,decision,stream_start_index,head_run_id,generation) VALUES($1,$2,$3,$4,$5,$6)")
                .bind(intent.original_run_id).bind(intent.request_id).bind(if intent.approved {"approved"} else {"denied"}).bind(original.next_index).bind(head.last_run_id).bind(generation).execute(&mut *tx).await.map_err(|_|FAILED)?;
        }
        sqlx::query("UPDATE forge_runtime.input_intents SET state='activated' WHERE handoff_id=$1 AND state='prepared'").bind(id).execute(&mut *tx).await.map_err(|_|FAILED)?;
        if original.deadline <= now(&mut tx).await? {
            return Err(LOST);
        }
        tx.commit().await.map_err(|_| FAILED)?;
        Ok(receipt)
    }
}
