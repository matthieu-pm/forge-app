use super::*;
#[derive(sqlx::FromRow)]
struct Conversation {
    workspace_id: String,
    user_id: String,
    last_run_id: Option<Uuid>,
}
impl Store {
    /// Admit a new user turn against the exact previous conversation head. The
    /// message has already been normalized and its attachment bytes authorized
    /// by the application. Client-supplied assistant/system history is forbidden.
    pub async fn admit(
        &self,
        channel: &Channel,
        conversation: Uuid,
        previous: Option<Uuid>,
        message: Value,
        deadline: DateTime<Utc>,
    ) -> Result<Session> {
        if message["role"] != "user"
            || message
                .as_object()
                .is_none_or(|v| v.len() != 2 || !v.contains_key("content"))
            || previous == Some(run(channel)?)
        {
            return Err(INVALID);
        }
        let deadline =
            DateTime::from_timestamp_millis(deadline.timestamp_millis()).ok_or(INVALID)?;
        // Validate the new input before taking the conversation lock. The complete
        // inherited context is validated again before publishing the admission.
        let fresh = State::new(channel, vec![message.clone()])?;
        let digest = json!({"binding":fresh.snapshot()["binding"],"conversation":conversation,"previous":previous,"message":message});
        let hash = format!(
            "{:x}",
            Sha256::digest(javascript_stringify(&digest).as_bytes())
        );
        let mut tx = self.pool.begin().await.map_err(|_| FAILED)?;
        sqlx::query("INSERT INTO forge_runtime.conversations(id,workspace_id,user_id) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING").bind(conversation).bind(channel.workspace_id()).bind(channel.principal_id()).execute(&mut *tx).await.map_err(|_|FAILED)?;
        let head:Conversation=sqlx::query_as("SELECT workspace_id,user_id,last_run_id FROM forge_runtime.conversations WHERE id=$1 FOR UPDATE").bind(conversation).fetch_one(&mut *tx).await.map_err(|_|FAILED)?;
        if head.workspace_id != channel.workspace_id() || head.user_id != channel.principal_id() {
            return Err(INVALID);
        }
        let existing = sqlx::query_as::<_, Row>(&format!(
            "SELECT {COLUMNS} FROM forge_runtime.sessions WHERE run_id=$1 FOR UPDATE"
        ))
        .bind(run(channel)?)
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
            let state = restored(&row, channel)?;
            tx.commit().await.map_err(|_| FAILED)?;
            return Ok(Session {
                state,
                next_index: row.next_index as u64,
                deadline: row.deadline,
                cancelled: row.cancelled_at.is_some(),
                worker_active: row.worker_active,
                continued_by: row.continued_by_run_id,
            });
        }
        if head.last_run_id != previous {
            return Err(Error("The conversation has a different latest run."));
        }
        if deadline <= now(&mut tx).await? {
            return Err(Error("The agent run deadline has elapsed."));
        }
        let mut initial_events = Vec::new();
        let mut consumed_parent = None;
        let state = if let Some(previous) = previous {
            let parent = sqlx::query_as::<_, Row>(&format!(
                "SELECT {COLUMNS} FROM forge_runtime.sessions WHERE run_id=$1 FOR UPDATE"
            ))
            .bind(previous)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|_| FAILED)?
            .ok_or(INVALID)?;
            scoped(&parent, channel)?;
            if parent.conversation_id != Some(conversation) || parent.continued_by_run_id.is_some()
            {
                return Err(INVALID);
            }
            let state = State::restore_parent(
                forge_core::json::parse(&parent.snapshot).map_err(|_| FAILED)?,
                channel,
                &previous.to_string(),
            )?;
            if let Some((next, events)) = state.question_continuation(
                channel,
                message.clone(),
                parent.cancelled_at.is_some(),
            )? {
                consumed_parent = Some((previous, parent.epoch.checked_add(1).ok_or(LOST)?));
                initial_events = events;
                next
            } else {
                if parent.cancelled_at.is_none()
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
        } else {
            fresh
        };
        state.validate(channel)?;
        if state.revision() != 0 {
            return Err(INVALID);
        }
        let text = javascript_stringify(&state.snapshot());
        if text.len() > LIMIT {
            return Err(INVALID);
        }
        // The conversation lock serializes siblings; the unique run ID also
        // prevents reusing an admission in a different conversation.
        sqlx::query("INSERT INTO forge_runtime.sessions(run_id,workspace_id,user_id,initial_hash,engine_state,deadline,conversation_id,parent_run_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)")
            .bind(run(channel)?).bind(channel.workspace_id()).bind(channel.principal_id()).bind(hash).bind(text).bind(deadline).bind(conversation).bind(previous).execute(&mut *tx).await.map_err(|_|FAILED)?;
        if !initial_events.is_empty() {
            let row = locked(&mut tx, channel).await?;
            let at = now(&mut tx).await?;
            append(&mut tx, channel, &row, &initial_events, at, false).await?;
        }
        if let Some((parent, epoch)) = consumed_parent {
            // The answer receipt, successor, and head advance commit together.
            // Fence the parked worker even if it has not yet released its lease.
            sqlx::query("UPDATE forge_runtime.sessions SET continued_by_run_id=$2,epoch=$3,lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE run_id=$1")
                .bind(parent).bind(run(channel)?).bind(epoch).execute(&mut *tx).await.map_err(|_|FAILED)?;
        }
        sqlx::query("UPDATE forge_runtime.conversations SET last_run_id=$2,updated_at=clock_timestamp() WHERE id=$1").bind(conversation).bind(run(channel)?).execute(&mut *tx).await.map_err(|_|FAILED)?;
        if deadline <= now(&mut tx).await? {
            return Err(Error("The agent run deadline has elapsed."));
        }
        tx.commit().await.map_err(|_| FAILED)?;
        Ok(Session {
            state,
            next_index: initial_events.len() as u64,
            deadline,
            cancelled: false,
            worker_active: false,
            continued_by: None,
        })
    }
}
