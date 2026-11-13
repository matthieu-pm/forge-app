use super::*;
use crate::engine::InputDelivery;
#[derive(sqlx::FromRow)]
pub(super) struct Conversation {
    pub workspace_id: String,
    pub user_id: String,
    pub last_run_id: Option<Uuid>,
    pub execution_run_id: Option<Uuid>,
    pub generation: i64,
    pub managed: bool,
    pub current_delivery_run_id: Option<Uuid>,
    pub intent_sequence: i64,
    pub drained_boundary: Option<String>,
}
pub(super) async fn lock_conversation(
    connection: &mut PgConnection,
    id: Uuid,
    channel: &Channel,
) -> Result<Conversation> {
    let head: Conversation = sqlx::query_as("SELECT workspace_id,user_id,last_run_id,execution_run_id,generation,managed,current_delivery_run_id,intent_sequence,drained_boundary::text AS drained_boundary FROM forge_runtime.conversations WHERE id=$1 FOR UPDATE")
        .bind(id).fetch_optional(connection).await.map_err(|_| FAILED)?.ok_or(INVALID)?;
    if head.workspace_id != channel.workspace_id() || head.user_id != channel.principal_id() {
        return Err(INVALID);
    }
    Ok(head)
}
pub(super) async fn lock_owner(
    connection: &mut PgConnection,
    id: Uuid,
    conversation: Uuid,
    channel: &Channel,
) -> Result<Row> {
    let row = sqlx::query_as::<_, Row>(&format!(
        "SELECT {COLUMNS} FROM forge_runtime.sessions WHERE run_id=$1 FOR UPDATE"
    ))
    .bind(id)
    .fetch_optional(connection)
    .await
    .map_err(|_| FAILED)?
    .ok_or(INVALID)?;
    scoped(&row, channel)?;
    if row.conversation_id != Some(conversation) || row.delivery_only {
        return Err(INVALID);
    }
    Ok(row)
}
pub(super) fn parent_state(row: &Row, channel: &Channel) -> Result<State> {
    State::restore_parent(
        forge_core::json::parse(&row.snapshot).map_err(|_| FAILED)?,
        channel,
        &row.run_id.to_string(),
    )
}
pub(super) fn next_generation(value: i64) -> Result<i64> {
    value
        .checked_add(1)
        .filter(|v| *v <= 9_007_199_254_740_991)
        .ok_or(INVALID)
}
impl Store {
    /// Scoped recovery metadata for a fresh delivery whose run is not admitted
    /// yet. This exposes neither historical messages nor capability credentials.
    pub async fn conversation(&self, channel: &Channel, id: Uuid) -> Result<ConversationProof> {
        let (head, generation, owner, next_index, deadline): (Uuid,i64,Uuid,i64,DateTime<Utc>) = sqlx::query_as("SELECT c.last_run_id,c.generation,s.run_id,s.next_index,s.deadline FROM forge_runtime.conversations c JOIN forge_runtime.sessions s ON s.run_id=c.execution_run_id AND s.conversation_id=c.id AND s.workspace_id=c.workspace_id AND s.user_id=c.user_id WHERE c.id=$1 AND c.workspace_id=$2 AND c.user_id=$3")
            .bind(id).bind(channel.workspace_id()).bind(channel.principal_id()).fetch_optional(&self.pool).await.map_err(|_|FAILED)?.ok_or(INVALID)?;
        Ok(ConversationProof {
            id,
            head_run_id: head,
            generation: generation as u64,
            owner_run_id: owner,
            owner_next_index: next_index as u64,
            owner_deadline: deadline.timestamp_millis(),
        })
    }
    pub async fn admit(
        &self,
        channel: &Channel,
        conversation: Uuid,
        previous: Option<Uuid>,
        message: Value,
        deadline: DateTime<Utc>,
    ) -> Result<Session> {
        self.admit_at(channel, conversation, previous, message, deadline, None)
            .await
    }
    /// Serialize delivery order independently from the run which owns execution.
    /// Expected generation fences an in-flight canonical response at the same head.
    pub async fn admit_at(
        &self,
        channel: &Channel,
        conversation: Uuid,
        previous: Option<Uuid>,
        message: Value,
        deadline: DateTime<Utc>,
        expected_generation: Option<u64>,
    ) -> Result<Session> {
        self.admit_inner(
            channel,
            conversation,
            previous,
            message,
            deadline,
            expected_generation,
            false,
        )
        .await
    }
    pub async fn admit_managed_at(
        &self,
        channel: &Channel,
        conversation: Uuid,
        previous: Option<Uuid>,
        message: Value,
        deadline: DateTime<Utc>,
        expected_generation: Option<u64>,
    ) -> Result<Session> {
        self.admit_inner(
            channel,
            conversation,
            previous,
            message,
            deadline,
            expected_generation,
            true,
        )
        .await
    }
    #[allow(clippy::too_many_arguments)]
    async fn admit_inner(
        &self,
        channel: &Channel,
        conversation: Uuid,
        previous: Option<Uuid>,
        message: Value,
        deadline: DateTime<Utc>,
        expected_generation: Option<u64>,
        managed: bool,
    ) -> Result<Session> {
        let run_id = run(channel)?;
        if message["role"] != "user"
            || message
                .as_object()
                .is_none_or(|v| v.len() != 2 || !v.contains_key("content"))
            || previous == Some(run_id)
            || expected_generation.is_some_and(|value| value > 9_007_199_254_740_991)
        {
            return Err(INVALID);
        }
        let deadline =
            DateTime::from_timestamp_millis(deadline.timestamp_millis()).ok_or(INVALID)?;
        let fresh = State::new(channel, vec![message.clone()])?;
        // Proof is not admission identity: a lost acknowledgement retry can carry
        // the committed generation while retaining the exact original input.
        let mut digest = json!({"binding":fresh.snapshot()["binding"],"conversation":conversation,"previous":previous,"message":message});
        if managed {
            digest["managed"] = json!(true);
            digest["authority"] = json!(queue::authority(channel));
        }
        let hash = format!(
            "{:x}",
            Sha256::digest(javascript_stringify(&digest).as_bytes())
        );
        let mut tx = self.pool.begin().await.map_err(|_| FAILED)?;
        sqlx::query("INSERT INTO forge_runtime.conversations(id,workspace_id,user_id) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING")
            .bind(conversation).bind(channel.workspace_id()).bind(channel.principal_id()).execute(&mut *tx).await.map_err(|_|FAILED)?;
        let head = lock_conversation(&mut tx, conversation, channel).await?;
        let existing = sqlx::query_as::<_, Row>(&format!(
            "SELECT {COLUMNS} FROM forge_runtime.sessions WHERE run_id=$1 FOR UPDATE"
        ))
        .bind(run_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| FAILED)?;
        if let Some(row) = existing {
            if row.conversation_id != Some(conversation)
                || row.parent_run_id != previous
                || row.initial_hash != hash
                || row.deadline != deadline
            {
                return Err(Error("The run already has a different runtime admission."));
            }
            restored(&row, channel)?;
            tx.commit().await.map_err(|_| FAILED)?;
            let mut session = self.load(channel).await.map_err(|_| FAILED)?;
            session.admission_replayed = true;
            return Ok(session);
        }
        // Legacy sessions did not persist immutable reasoning selection. Start
        // managed delivery on a fresh conversation rather than strand an older
        // run's still-valid canonical approvals during a mixed upgrade.
        if managed && !head.managed && head.last_run_id.is_some() {
            return Err(INVALID);
        }
        if head.managed {
            if !managed {
                return Err(INVALID);
            }
            queue::admission_barrier(&mut tx, conversation, &head, channel).await?;
        }
        if head.last_run_id != previous
            || expected_generation.is_some_and(|generation| generation != head.generation as u64)
        {
            return Err(Error("The conversation has a different latest delivery."));
        }
        if deadline <= now(&mut tx).await? {
            return Err(Error("The agent run deadline has elapsed."));
        }
        let mut initial_events = vec![];
        let mut delivery_only = false;
        let mut owner_id = run_id;
        let state = if previous.is_some() {
            let parent = lock_owner(
                &mut tx,
                head.execution_run_id.ok_or(INVALID)?,
                conversation,
                channel,
            )
            .await?;
            if parent.continued_by_run_id.is_some() {
                return Err(INVALID);
            }
            let state = parent_state(&parent, channel)?;
            // Pending batches exist only at a parked/finished delivery boundary.
            if parent.cancelled_at.is_none()
                && !matches!(
                    state.phase(),
                    Phase::Waiting | Phase::Complete | Phase::Cancelled | Phase::Failed
                )
            {
                return Err(Error("The previous conversation run has not ended."));
            }
            let cancelled = parent.cancelled_at.is_some()
                || matches!(state.phase(), Phase::Cancelled | Phase::Failed);
            let next = match state.compose_input(channel, message.clone(), cancelled)? {
                Some(InputDelivery::Deferred {
                    owner,
                    delivery,
                    events,
                }) => {
                    if cancelled {
                        return Err(INVALID);
                    }
                    let text = javascript_stringify(&owner.snapshot());
                    if text.len() > LIMIT {
                        return Err(INVALID);
                    }
                    sqlx::query("UPDATE forge_runtime.sessions SET revision=$2,engine_state=$3::jsonb,epoch=$4,lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE run_id=$1")
                        .bind(parent.run_id).bind(owner.revision() as i64).bind(text).bind(parent.epoch.checked_add(1).ok_or(LOST)?).execute(&mut *tx).await.map_err(|_|FAILED)?;
                    owner_id = parent.run_id;
                    delivery_only = true;
                    initial_events = events;
                    delivery
                }
                Some(InputDelivery::Resolved { state, events }) => {
                    initial_events = events;
                    state
                }
                None => {
                    if !cancelled
                        && !matches!(
                            state.phase(),
                            Phase::Complete | Phase::Cancelled | Phase::Failed
                        )
                    {
                        return Err(Error("The previous conversation run has not ended."));
                    }
                    let mut history = state.next_history();
                    history.push(message);
                    let mut next = State::new(channel, history)?;
                    next.inherit_context(&state);
                    next
                }
            };
            if !delivery_only {
                sqlx::query("UPDATE forge_runtime.sessions SET continued_by_run_id=$2,epoch=$3,lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE run_id=$1")
                    .bind(parent.run_id).bind(run_id).bind(parent.epoch.checked_add(1).ok_or(LOST)?).execute(&mut *tx).await.map_err(|_|FAILED)?;
            }
            next
        } else {
            fresh
        };
        state.validate(channel)?;
        let text = javascript_stringify(&state.snapshot());
        if state.revision() != 0 || text.len() > LIMIT {
            return Err(INVALID);
        }
        sqlx::query("INSERT INTO forge_runtime.sessions(run_id,workspace_id,user_id,initial_hash,engine_state,deadline,conversation_id,parent_run_id,delivery_only,authority) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb)")
            .bind(run_id).bind(channel.workspace_id()).bind(channel.principal_id()).bind(hash).bind(text).bind(deadline).bind(conversation).bind(previous).bind(delivery_only).bind(javascript_stringify(&json!(queue::authority(channel)))).execute(&mut *tx).await.map_err(|_|FAILED)?;
        if !initial_events.is_empty() {
            let row = locked(&mut tx, channel).await?;
            let at = now(&mut tx).await?;
            append(&mut tx, channel, &row, &initial_events, at, false).await?;
        }
        let generation = next_generation(head.generation)?;
        sqlx::query("UPDATE forge_runtime.conversations SET last_run_id=$2,execution_run_id=$3,current_delivery_run_id=$2,generation=$4,managed=$5,drained_boundary=NULL,updated_at=clock_timestamp() WHERE id=$1")
            .bind(conversation).bind(run_id).bind(owner_id).bind(generation).bind(managed).execute(&mut *tx).await.map_err(|_|FAILED)?;
        if deadline <= now(&mut tx).await? {
            return Err(Error("The agent run deadline has elapsed."));
        }
        tx.commit().await.map_err(|_| FAILED)?;
        self.load(channel).await.map_err(|_| FAILED)
    }
}
