//! Queue capture and lease reconciliation never contact an agent/provider.
//! Definition locks are held through capture so disable cannot miss a new run.
use super::*;
use chrono::{Duration, NaiveDate};

#[derive(FromRow)]
struct NativeEvent {
    id: Uuid,
    workspace_id: String,
    team_id: Uuid,
    entity: String,
    entity_id: Uuid,
    event: String,
    before: Option<Value>,
    after: Value,
    created_at: DateTime<Utc>,
}
#[derive(FromRow)]
struct Scheduled {
    #[sqlx(flatten)]
    definition: Definition,
    enabled_at: Option<DateTime<Utc>>,
    next_run_at: Option<DateTime<Utc>>,
}
#[derive(FromRow)]
struct Cycle {
    id: Uuid,
    start_date: String,
    end_date: String,
    timezone: String,
    snapshot: Value,
}
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpiredRuns {
    pub approvals: u64,
    pub workers: u64,
}
impl Service {
    /// Consume at most `limit` audience rows. One source change may have several
    /// audiences; its canonical identity deliberately excludes the audience team.
    pub async fn enqueue_native(
        &self,
        limit: usize,
        workspace: Option<&str>,
    ) -> Result<usize, StoreError> {
        if !self.options.enabled {
            return Ok(0);
        }
        let mut processed = 0;
        for _ in 0..limit {
            let mut tx = self.database.begin().await?;
            let event: Option<NativeEvent> = sqlx::query_as(
                "SELECT * FROM loop_events WHERE processed_at IS NULL AND ($1::text IS NULL OR workspace_id=$1) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",
            ).bind(workspace).fetch_optional(&mut *tx).await?;
            let Some(event) = event else {
                tx.commit().await?;
                break;
            };
            let visibility: Option<String> = sqlx::query_scalar(
                "SELECT visibility FROM teams WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL",
            ).bind(&event.workspace_id).bind(event.team_id).fetch_optional(&mut *tx).await?;
            let definitions: Vec<Definition> = if let Some(visibility) = visibility {
                sqlx::query_as(
                    "SELECT * FROM team_loops WHERE workspace_id=$1 AND enabled AND deleted_at IS NULL AND enabled_at<=$2 AND (team_id=$3 OR ($4::boolean AND fields->>'teamAccess'='all-public-teams')) ORDER BY id FOR SHARE",
                ).bind(&event.workspace_id).bind(event.created_at).bind(event.team_id).bind(visibility == "workspace").fetch_all(&mut *tx).await?
            } else {
                vec![]
            };
            let before = event.before.unwrap_or(Value::Null);
            let matches =
                contract::match_events(&event.entity, &event.event, &before, &event.after);
            let key = format!(
                "native:{}",
                forge_core::canonical::command_input_hash(
                    &json!({"entity":event.entity,"entityId":event.entity_id,"event":event.event,"before":before,"after":event.after,"at":stamp(event.created_at)})
                )
            );
            tx.prepare().await?;
            for definition in definitions {
                let Some(matched) = matches
                    .iter()
                    .find(|m| contract::matches_event(&definition.fields, m))
                else {
                    continue;
                };
                let mut input = json!({"kind":"native","entity":event.entity,"entityId":event.entity_id,"trigger":matched["event"],"context":matched["after"]});
                for kind in ["comment", "update"] {
                    if let Some(activity) = matched.get(kind) {
                        input[kind] = activity.clone();
                    }
                }
                enqueue(&mut tx, &definition, &key, input).await?;
            }
            sqlx::query("UPDATE loop_events SET processed_at=$1 WHERE id=$2")
                .bind(self.time())
                .bind(event.id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            processed += 1;
        }
        Ok(processed)
    }

    /// Coalesce overdue schedules to one captured occurrence, then advance past
    /// `now`. Cycle occurrences use the saved cycle timezone and inclusive end.
    pub async fn enqueue_scheduled(
        &self,
        now: DateTime<Utc>,
        workspace: Option<&str>,
    ) -> Result<usize, StoreError> {
        if !self.options.enabled {
            return Ok(0);
        }
        let mut tx = self.database.begin().await?;
        let definitions: Vec<Scheduled> = sqlx::query_as(
            "SELECT * FROM team_loops WHERE enabled AND deleted_at IS NULL AND ($1::text IS NULL OR workspace_id=$1) ORDER BY id FOR UPDATE SKIP LOCKED",
        ).bind(workspace).fetch_all(&mut *tx).await?;
        let mut count = 0;
        for scheduled in definitions {
            let definition = scheduled.definition;
            let trigger = &definition.fields["trigger"];
            if trigger["kind"] == "schedule" {
                let Some(due) = scheduled.next_run_at.filter(|due| *due <= now) else {
                    continue;
                };
                let next = contract::next_scheduled_at(trigger, now)
                    .map_err(|_| StoreError::InvalidInput)?;
                tx.prepare().await?;
                enqueue(
                    &mut tx,
                    &definition,
                    &format!("schedule:{}", stamp(due)),
                    json!({"kind":"schedule","scheduledAt":stamp(due)}),
                )
                .await?;
                sqlx::query("UPDATE team_loops SET next_run_at=$1 WHERE id=$2")
                    .bind(next)
                    .bind(definition.id)
                    .execute(&mut *tx)
                    .await?;
                count += 1;
            } else if trigger["kind"] == "event"
                && trigger["entity"] == "cycle"
                && matches!(trigger["event"].as_str(), Some("started" | "completed"))
            {
                let cycles: Vec<Cycle> = sqlx::query_as(
                    "SELECT c.id,c.start_date,c.end_date,c.timezone,to_jsonb(c) AS snapshot FROM issue_cycles c JOIN teams t ON t.workspace_id=c.workspace_id AND t.id=c.team_id WHERE c.workspace_id=$1 AND t.deleted_at IS NULL AND (CASE WHEN $2 THEN c.team_id=$3 ELSE t.visibility='workspace' END) ORDER BY c.id",
                ).bind(&definition.workspace_id).bind(definition.fields["teamAccess"] == "this-team").bind(definition.team_id).fetch_all(&mut *tx).await?;
                for cycle in cycles {
                    let boundary = if trigger["event"] == "started" {
                        cycle.start_date
                    } else {
                        NaiveDate::parse_from_str(&cycle.end_date, "%Y-%m-%d")
                            .map_err(|_| StoreError::InvalidInput)?
                            .succ_opt()
                            .ok_or(StoreError::InvalidInput)?
                            .to_string()
                    };
                    let start =
                        contract::schedule_start(&format!("{boundary}T00:00"), &cycle.timezone)
                            .map_err(|_| StoreError::InvalidInput)?;
                    let instant = DateTime::parse_from_rfc3339(&start)
                        .map_err(|_| StoreError::InvalidInput)?
                        .with_timezone(&Utc);
                    if instant > now || scheduled.enabled_at.is_none_or(|at| instant < at) {
                        continue;
                    }
                    let after = contract::normalize_snapshot("cycle", &cycle.snapshot);
                    if !contract::matches_event(
                        &definition.fields,
                        &json!({"entity":"cycle","event":trigger["event"],"before":null,"after":after}),
                    ) {
                        continue;
                    }
                    tx.prepare().await?;
                    enqueue(&mut tx, &definition, &format!("cycle:{}:{}:{boundary}", cycle.id, trigger["event"].as_str().unwrap()), json!({"kind":"cycle","entity":"cycle","entityId":cycle.id,"context":after})).await?;
                    // Source reporting counts matching cycle occurrences even
                    // when the immutable event receipt already exists.
                    count += 1;
                }
            }
        }
        tx.commit().await?;
        Ok(count)
    }

    /// A stale worker's effects are unknown; never return it to the runnable queue.
    pub async fn expire_runs(
        &self,
        now: DateTime<Utc>,
        workspace: Option<&str>,
    ) -> Result<ExpiredRuns, StoreError> {
        if !self.options.enabled {
            return Ok(ExpiredRuns::default());
        }
        let mut tx = self.database.begin().await?;
        tx.prepare().await?;
        let approvals = sqlx::query("UPDATE loop_runs SET state='failed',error_code='RUN_WALL_CLOCK_LIMIT',finished_at=$1,pending_decision=NULL WHERE state='waiting-for-approval' AND started_at<=$2 AND pending_decision->>'action' IS DISTINCT FROM 'cancel-run' AND ($3::text IS NULL OR workspace_id=$3)")
            .bind(now).bind(now - Duration::milliseconds(contract::RUN_WALL_CLOCK_MS)).bind(workspace).execute(&mut *tx).await?.rows_affected();
        let workers = sqlx::query("UPDATE loop_runs SET state='uncertain',error_code='WORKER_LEASE_EXPIRED',finished_at=$1 WHERE state='running' AND lease_at<=$2 AND ($3::text IS NULL OR workspace_id=$3)")
            .bind(now).bind(now - Duration::milliseconds(contract::RUN_LEASE_MS)).bind(workspace).execute(&mut *tx).await?.rows_affected();
        tx.commit().await?;
        Ok(ExpiredRuns { approvals, workers })
    }
}
