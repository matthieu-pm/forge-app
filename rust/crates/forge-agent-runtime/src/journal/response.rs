use super::conversation::{lock_conversation, lock_owner, next_generation, parent_state};
use super::*;

pub struct ResponseProof {
    pub conversation_id: Uuid,
    pub expected_head_run_id: Uuid,
    pub expected_generation: u64,
}
pub struct InputReceipt {
    pub generation: u64,
    pub stream_start_index: u64,
    pub replayed: bool,
    pub current_delivery: bool,
    pub conversation: Option<ConversationProof>,
}
#[derive(sqlx::FromRow)]
struct Receipt {
    decision: String,
    stream_start_index: i64,
    head_run_id: Option<Uuid>,
    generation: i64,
}
impl Store {
    /// Canonical intent is delivered to the current conversation state using the
    /// original run's authority. The issued request and receipt never move runs.
    pub async fn respond_at(
        &self,
        channel: &Channel,
        request: &str,
        decision: Decision,
        proof: Option<ResponseProof>,
    ) -> Result<InputReceipt> {
        let request_id = Uuid::parse_str(request).map_err(|_| INVALID)?;
        let run_id = run(channel)?;
        let decision_text = if decision == Decision::Approved {
            "approved"
        } else {
            "denied"
        };
        let mut tx = self.pool.begin().await.map_err(|_| FAILED)?;
        // Conversation identity is immutable. Acquire its lock before any session
        // row, matching composer admission, then recheck the scoped original row.
        let conversation_id: Option<Uuid>=sqlx::query_scalar("SELECT conversation_id FROM forge_runtime.sessions WHERE run_id=$1 AND workspace_id=$2 AND user_id=$3")
            .bind(run_id).bind(channel.workspace_id()).bind(channel.principal_id()).fetch_optional(&mut *tx).await.map_err(|_|FAILED)?.ok_or(INVALID)?;
        let head = match conversation_id {
            Some(id) => Some(lock_conversation(&mut tx, id, channel).await?),
            None => None,
        };
        let original = locked(&mut tx, channel).await?;
        if original.conversation_id != conversation_id || original.delivery_only {
            return Err(INVALID);
        }
        let original_state = parent_state(&original, channel)?;
        if original_state.issued_request(request).is_none() {
            return Err(INVALID);
        }
        let receipt=sqlx::query_as::<_,Receipt>("SELECT decision,stream_start_index,head_run_id,generation FROM forge_runtime.input_deliveries WHERE run_id=$1 AND request_id=$2")
            .bind(run_id).bind(request_id).fetch_optional(&mut *tx).await.map_err(|_|FAILED)?;
        if let Some(receipt) = receipt {
            if receipt.decision != decision_text {
                return Err(INVALID);
            }
            let current_delivery = original.cancelled_at.is_none()
                && original.continued_by_run_id.is_none()
                && match &head {
                    Some(head) => {
                        head.last_run_id == receipt.head_run_id
                            && head.generation == receipt.generation
                            && head.execution_run_id == Some(run_id)
                    }
                    None => {
                        receipt.head_run_id.is_none()
                            && original.input_generation == receipt.generation
                    }
                };
            let conversation = if let (Some(id), Some(head)) = (conversation_id, &head) {
                let owner =
                    lock_owner(&mut tx, head.execution_run_id.ok_or(INVALID)?, id, channel).await?;
                Some(ConversationProof {
                    id,
                    head_run_id: head.last_run_id.ok_or(INVALID)?,
                    generation: head.generation as u64,
                    owner_run_id: owner.run_id,
                    owner_next_index: owner.next_index as u64,
                    owner_deadline: owner.deadline.timestamp_millis(),
                })
            } else {
                None
            };
            tx.commit().await.map_err(|_| FAILED)?;
            return Ok(InputReceipt {
                generation: receipt.generation as u64,
                stream_start_index: receipt.stream_start_index as u64,
                replayed: true,
                current_delivery,
                conversation,
            });
        }
        if let Some(proof) = proof {
            let head = head.as_ref().ok_or(INVALID)?;
            if Some(proof.conversation_id) != conversation_id
                || Some(proof.expected_head_run_id) != head.last_run_id
                || proof.expected_generation != head.generation as u64
            {
                return Err(INVALID);
            }
        }
        let at = now(&mut tx).await?;
        if original.cancelled_at.is_some()
            || original.deadline <= at
            || matches!(original_state.phase(), Phase::Cancelled | Phase::Failed)
        {
            return Err(LOST);
        }
        let owner = if let (Some(id), Some(head)) = (conversation_id, &head) {
            lock_owner(&mut tx, head.execution_run_id.ok_or(INVALID)?, id, channel).await?
        } else {
            locked(&mut tx, channel).await?
        };
        let owner_state = parent_state(&owner, channel)?;
        if owner.cancelled_at.is_some()
            || owner.continued_by_run_id.is_some()
            || !matches!(owner_state.phase(), Phase::Waiting | Phase::Complete)
        {
            return Err(LOST);
        }
        let (next, events) =
            owner_state.canonical_input(channel, &original_state, request, decision)?;
        let text = javascript_stringify(&next.snapshot());
        if text.len() > LIMIT {
            return Err(INVALID);
        }
        let generation = next_generation(
            head.as_ref()
                .map_or(original.input_generation, |head| head.generation),
        )?;
        sqlx::query("UPDATE forge_runtime.sessions SET revision=$2,engine_state=$3::jsonb,epoch=$4,lease_owner=NULL,lease_until=NULL,continued_by_run_id=NULL,updated_at=$5,input_generation=$6 WHERE run_id=$1")
            .bind(run_id).bind(next.revision() as i64).bind(text).bind(original.epoch.checked_add(1).ok_or(LOST)?).bind(at).bind(generation).execute(&mut *tx).await.map_err(|_|FAILED)?;
        append(&mut tx, channel, &original, &events, at, false).await?;
        if owner.run_id != run_id {
            sqlx::query("UPDATE forge_runtime.sessions SET continued_by_run_id=$2,epoch=$3,lease_owner=NULL,lease_until=NULL,updated_at=$4 WHERE run_id=$1")
                .bind(owner.run_id).bind(run_id).bind(owner.epoch.checked_add(1).ok_or(LOST)?).bind(at).execute(&mut *tx).await.map_err(|_|FAILED)?;
        }
        let conversation = if let (Some(id), Some(head)) = (conversation_id, &head) {
            sqlx::query("UPDATE forge_runtime.conversations SET execution_run_id=$2,generation=$3,updated_at=$4 WHERE id=$1")
                .bind(id).bind(run_id).bind(generation).bind(at).execute(&mut *tx).await.map_err(|_|FAILED)?;
            Some(ConversationProof {
                id,
                head_run_id: head.last_run_id.ok_or(INVALID)?,
                generation: generation as u64,
                owner_run_id: run_id,
                owner_next_index: original.next_index as u64 + events.len() as u64,
                owner_deadline: original.deadline.timestamp_millis(),
            })
        } else {
            None
        };
        sqlx::query("INSERT INTO forge_runtime.input_deliveries(run_id,request_id,decision,stream_start_index,head_run_id,generation) VALUES($1,$2,$3,$4,$5,$6)")
            .bind(run_id).bind(request_id).bind(decision_text).bind(original.next_index).bind(conversation.as_ref().map(|p|p.head_run_id)).bind(generation).execute(&mut *tx).await.map_err(|_|FAILED)?;
        if original.deadline <= now(&mut tx).await? {
            return Err(LOST);
        }
        tx.commit().await.map_err(|_| FAILED)?;
        Ok(InputReceipt {
            generation: generation as u64,
            stream_start_index: original.next_index as u64,
            replayed: false,
            current_delivery: true,
            conversation,
        })
    }
}
