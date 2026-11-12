use super::*;
use forge_core::actor::ApiScope;

#[derive(FromRow, Clone)]
struct Period {
    id: Uuid,
    kind: String,
    binding: String,
    started_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
}
struct Budget {
    access: Value,
    account: Period,
    settled: u64,
    reserved: u64,
    carry_count: usize,
}
async fn period(
    c: &mut PgConnection,
    workspace: &str,
    kind: &str,
    binding: &str,
    window: &Value,
) -> Result<Period, StoreError> {
    let key = json!(["forge.usage-account", kind, window["key"]]).to_string();
    let start = date(&window["start"])?;
    let end = date(&window["end"])?;
    sqlx::query("INSERT INTO workspace_usage_periods(workspace_id,kind,binding,period_key,started_at,ends_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING")
        .bind(workspace).bind(kind).bind(binding).bind(&key).bind(start).bind(end).execute(&mut *c).await?;
    let row: Period = sqlx::query_as(
        "SELECT * FROM workspace_usage_periods WHERE workspace_id=$1 AND period_key=$2",
    )
    .bind(workspace)
    .bind(key)
    .fetch_optional(c)
    .await?
    .ok_or_else(|| fail("USAGE_PERIOD_BINDING_CONFLICT"))?;
    if row.kind != kind || row.binding != binding || row.started_at != start || row.ends_at != end {
        return Err(fail("USAGE_PERIOD_BINDING_CONFLICT"));
    }
    Ok(row)
}
fn at(value: &Value) -> Option<DateTime<Utc>> {
    date(value).ok()
}
async fn authority(
    c: &mut PgConnection,
    workspace: &Workspace,
    now: DateTime<Utc>,
) -> Result<Budget, StoreError> {
    let state = state(c, &workspace.id).await?;
    let access = policy::usage::authority(
        &json!({"workspaceId":workspace.id,"workspaceCreatedAt":stamp(workspace.created_at),"state":state,"now":stamp(now)}),
    )?;
    let candidates: Vec<Period> = sqlx::query_as(
        "SELECT * FROM workspace_usage_periods WHERE workspace_id=$1 ORDER BY started_at DESC",
    )
    .bind(&workspace.id)
    .fetch_all(&mut *c)
    .await?;
    let account = if access["grace"] == true {
        candidates
            .iter()
            .find(|p| {
                p.kind == "paid"
                    && access["binding"] == p.binding
                    && ((Some(p.started_at) == at(&state["currentPeriodStart"])
                        && Some(p.ends_at) == at(&state["currentPeriodEnd"]))
                        || Some(p.ends_at) == at(&state["currentPeriodStart"])
                        || Some(p.ends_at) == at(&state["paymentFailedAt"]))
            })
            .cloned()
            .ok_or_else(|| fail("USAGE_GRACE_ORIGINAL_PERIOD_REQUIRED"))?
    } else {
        if access["period"].is_null() {
            return Err(fail("USAGE_PERIOD_RECONCILIATION_REQUIRED"));
        }
        period(
            c,
            &workspace.id,
            text(&access["kind"])?,
            text(&access["binding"])?,
            &access["period"],
        )
        .await?
    };
    let transition = &access["transition"];
    if !transition.is_null() {
        let source_kind = if transition["kind"] == "trial-expiry" {
            "trial"
        } else {
            "paid"
        };
        let source = candidates.iter().find(|p| {
            p.kind == source_kind
                && transition["binding"] == p.binding
                && ((Some(p.started_at) == at(&transition["sourceStart"])
                    && Some(p.ends_at) == at(&transition["sourceEnd"]))
                    || (!transition["failedAt"].is_null()
                        && (Some(p.ends_at) == at(&transition["sourceStart"])
                            || Some(p.ends_at) == at(&transition["failedAt"]))))
        });
        if let Some(source) = source {
            let effective = date(&transition["effectiveAt"])?;
            let window = policy::calendar::period(
                &workspace.id,
                effective,
                &json!({"kind":"free","workspaceCreatedAt":stamp(workspace.created_at)}),
            )?;
            let target = period(
                c,
                &workspace.id,
                "free",
                &stamp(workspace.created_at),
                &window,
            )
            .await?;
            sqlx::query("INSERT INTO workspace_usage_carryovers(workspace_id,source_period_id,target_period_id,kind,effective_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING")
                .bind(&workspace.id).bind(source.id).bind(target.id).bind(text(&transition["kind"])?).bind(effective).execute(&mut *c).await?;
            let saved: Option<(Uuid, DateTime<Utc>)> = sqlx::query_as("SELECT target_period_id,effective_at FROM workspace_usage_carryovers WHERE source_period_id=$1")
                .bind(source.id).fetch_optional(&mut *c).await?;
            if saved != Some((target.id, effective)) {
                return Err(fail("USAGE_TRANSITION_RECONCILIATION_REQUIRED"));
            }
        }
    }
    let mut ids: Vec<Uuid> = sqlx::query_scalar("SELECT source_period_id FROM workspace_usage_carryovers WHERE workspace_id=$1 AND target_period_id=$2")
        .bind(&workspace.id).bind(account.id).fetch_all(&mut *c).await?;
    let carry_count = ids.len();
    ids.push(account.id);
    let (settled,reserved): (String,String) = sqlx::query_as("SELECT coalesce(sum(settled_usd_micros),0)::text,coalesce(sum(reserved_usd_micros),0)::text FROM workspace_usage_reservations WHERE workspace_id=$1 AND uses_pool=true AND period_id=ANY($2)")
        .bind(&workspace.id).bind(ids).fetch_one(c).await?;
    let parse = |s: String| {
        s.parse::<u64>()
            .ok()
            .filter(|n| *n <= policy::MAX_SAFE)
            .ok_or_else(|| fail("BILLING_INTEGER_OVERFLOW"))
    };
    let settled = parse(settled)?;
    let reserved = parse(reserved)?;
    if settled + reserved > policy::MAX_SAFE {
        return Err(fail("BILLING_INTEGER_OVERFLOW"));
    }
    Ok(Budget {
        access,
        account,
        settled,
        reserved,
        carry_count,
    })
}
#[derive(FromRow)]
struct Connection {
    id: Uuid,
    status: String,
    locality: String,
    execution_kind: String,
    scope: String,
    user_id: Option<String>,
    provider: String,
    billing_mode: String,
}
#[derive(FromRow)]
struct Reservation {
    id: Uuid,
    workspace_id: String,
    request_hash: String,
    operation_id: Uuid,
    period_id: Uuid,
    state: String,
    maximum_cost_usd_micros: i64,
}
impl Service {
    /// The caller owns a trusted bounded price quote. This is intentionally not
    /// wired to a browser action or the live runtime, matching the source gate.
    pub async fn admit_agent_usage(
        &self,
        actor: &Actor,
        value: Value,
    ) -> Result<Value, StoreError> {
        if !actor.has_scope(ApiScope::AgentsWrite) {
            return Err(StoreError::Forbidden);
        }
        if !matches!(actor.authentication, Authentication::Session { .. }) {
            return Err(fail("USAGE_FIRST_PARTY_SESSION_REQUIRED"));
        }
        fields(
            &value,
            &[
                "requestId",
                "runId",
                "threadId",
                "connectionId",
                "modelId",
                "maximumCostUsdMicros",
                "pricingFingerprint",
            ],
        )?;
        let request = id(&value["requestId"])?;
        let run = id(&value["runId"])?;
        let thread = id(&value["threadId"])?;
        let connection_id = id(&value["connectionId"])?;
        let model = text(&value["modelId"])?;
        let fingerprint = text(&value["pricingFingerprint"])?;
        if model.is_empty()
            || forge_core::text::length(model) > 255
            || fingerprint.len() != 64
            || !fingerprint
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid());
        }
        let maximum = policy::safe_integer(&value["maximumCostUsdMicros"], 0)?;
        // Source schema order and the original UUID spelling are hash authority.
        let body_hash = hash(
            &json!({"actorUserId":actor.user_id,"workspaceId":actor.workspace_id,
            "requestId":value["requestId"],"runId":value["runId"],"threadId":value["threadId"],
            "connectionId":value["connectionId"],"modelId":model,"maximumCostUsdMicros":maximum,"pricingFingerprint":fingerprint}),
        );
        let mut tx = self.database.begin().await?;
        let (workspace, now) = fence(&mut tx, &actor.workspace_id).await?;
        let current = live(&mut tx, actor, false).await?;
        let block: Option<bool> = sqlx::query_scalar("SELECT block_guest_agent_access FROM workspace_security_settings WHERE workspace_id=$1 FOR SHARE")
            .bind(&workspace.id).fetch_optional(&mut *tx).await?;
        if block == Some(true) && current.has_role(&["guest"]) {
            return Err(fail("USAGE_GUEST_AGENT_ACCESS_DENIED"));
        }
        let prior: Option<Reservation> =
            sqlx::query_as("SELECT * FROM workspace_usage_reservations WHERE request_id=$1")
                .bind(request)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(prior) = prior {
            if prior.workspace_id != workspace.id || prior.request_hash != body_hash {
                return Err(fail("USAGE_REQUEST_CONFLICT"));
            }
            tx.commit().await?;
            return Ok(
                json!({"reservationId":prior.id,"runId":prior.operation_id,"periodId":prior.period_id,"replayed":true}),
            );
        }
        let owner: Option<(String,Option<String>)> = sqlx::query_as("SELECT status,created_by_user_id FROM agent_threads WHERE id=$1 AND workspace_id=$2 FOR SHARE")
            .bind(thread).bind(&workspace.id).fetch_optional(&mut *tx).await?;
        if owner != Some(("active".into(), Some(actor.user_id.clone()))) {
            return Err(fail("USAGE_THREAD_NOT_FOUND"));
        }
        let connection: Connection = sqlx::query_as(
            "SELECT * FROM model_connections WHERE id=$1 AND workspace_id=$2 FOR SHARE",
        )
        .bind(connection_id)
        .bind(&workspace.id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| fail("USAGE_MODEL_CONNECTION_UNAVAILABLE"))?;
        if connection.status != "ready"
            || connection.locality != "server-capable"
            || connection.execution_kind != "forge-native"
            || (connection.scope == "personal"
                && connection.user_id.as_deref() != Some(&actor.user_id))
        {
            return Err(fail("USAGE_MODEL_CONNECTION_UNAVAILABLE"));
        }
        let catalog: Option<(Option<DateTime<Utc>>,)> = sqlx::query_as("SELECT expires_at FROM model_catalog_entries WHERE connection_id=$1 AND provider_model_id=$2 AND status='available' LIMIT 1 FOR SHARE")
            .bind(connection.id).bind(model).fetch_optional(&mut *tx).await?;
        if catalog.is_none_or(|(expires,)| expires.is_some_and(|e| e <= now)) {
            return Err(fail("USAGE_MODEL_UNAVAILABLE"));
        }
        let capacity: Option<i32> = sqlx::query_scalar("SELECT active_member_count FROM workspace_member_capacity WHERE workspace_id=$1 FOR SHARE")
            .bind(&workspace.id).fetch_optional(&mut *tx).await?;
        let capacity = capacity
            .filter(|n| *n >= 1)
            .ok_or_else(|| fail("USAGE_MEMBERSHIP_CAPACITY_REQUIRED"))?;
        tx.prepare().await?;
        let budget = authority(&mut tx, &workspace, now).await?;
        let uses_pool = policy::charge(
            &json!({"plan":budget.access["plan"],"accessPhase":budget.access["phase"],"feature":"agent","billingMode":connection.billing_mode}),
        )?;
        if uses_pool && maximum == 0 {
            return Err(fail("USAGE_BOUNDED_PRICING_REQUIRED"));
        }
        let allowance = policy::budget::allowance(
            &json!({"plan":budget.access["plan"],"accessPhase":budget.access["phase"],"activeMembers":capacity}),
        )?;
        let committed = budget.settled + budget.reserved;
        let projected = committed + if uses_pool { maximum } else { 0 };
        if projected > policy::MAX_SAFE {
            return Err(fail("BILLING_INTEGER_OVERFLOW"));
        }
        // Paid plan alone never implies overage consent or authority.
        if uses_pool && (committed >= allowance || projected > allowance) {
            return Err(fail("USAGE_ALLOWANCE_EXHAUSTED"));
        }
        sqlx::query("INSERT INTO agent_runs(id,thread_id,initiated_by_user_id,execution_kind,requested_selection,resolved_connection_id,resolved_model_id) VALUES($1,$2,$3,$4,$5,$6,$7)")
            .bind(run).bind(thread).bind(&actor.user_id).bind(&connection.execution_kind)
            .bind(json!({"mode":"manual","provider":connection.provider,"billingMode":connection.billing_mode})).bind(connection.id).bind(model).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO workspace_usage_reservations(id,workspace_id,period_id,request_id,request_hash,operation_id,run_id,actor_user_id,provider,model_id,pricing_fingerprint,billing_mode,feature,uses_pool,maximum_cost_usd_micros,reserved_usd_micros) VALUES($1,$2,$3,$4,$5,$1,$1,$6,$7,$8,$9,$10,'agent',$11,$12,$12)")
            .bind(run).bind(&workspace.id).bind(budget.account.id).bind(request).bind(body_hash).bind(&actor.user_id).bind(&connection.provider).bind(model).bind(fingerprint).bind(&connection.billing_mode).bind(uses_pool).bind(maximum as i64).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO agent_events(thread_id,run_id,source,source_event_id,sequence,type,schema_version,payload_json,occurred_at) VALUES($1,$2,'forge',$3,1,'run.created',1,$4,$5)")
            .bind(thread).bind(run).bind(format!("{}:created",text(&value["runId"])?)).bind(json!({"billingReservationId":value["runId"]})).bind(now).execute(&mut *tx).await?;
        audit(&mut tx,&workspace.id,Some(&actor.user_id),"usage.agent.admitted",text(&value["runId"])?,text(&value["requestId"])?,
            json!({"periodId":budget.account.id,"usesPool":uses_pool,"maximumCostUsdMicros":maximum})).await?;
        tx.commit().await?;
        Ok(
            json!({"reservationId":value["runId"],"runId":value["runId"],"periodId":budget.account.id,"replayed":false}),
        )
    }
    /// Trusted provider/recovery sink, never a browser assertion of cost.
    pub async fn settle_agent_usage(&self, value: Value) -> Result<Value, StoreError> {
        fields(
            &value,
            &[
                "workspaceId",
                "reservationId",
                "eventId",
                "outcome",
                "providerCostUsdMicros",
            ],
        )?;
        let workspace = text(&value["workspaceId"])?;
        if workspace.is_empty() {
            return Err(invalid());
        }
        let reservation = id(&value["reservationId"])?;
        let event = id(&value["eventId"])?;
        let outcome = text(&value["outcome"])?;
        if !["settled", "confirmed-no-charge", "uncertain"].contains(&outcome) {
            return Err(invalid());
        }
        let cost = policy::safe_integer(&value["providerCostUsdMicros"], 0)?;
        let body_hash = hash(
            &json!({"workspaceId":workspace,"reservationId":value["reservationId"],"eventId":value["eventId"],"outcome":outcome,"providerCostUsdMicros":cost}),
        );
        if outcome != "settled" && cost != 0 {
            return Err(fail("USAGE_SETTLEMENT_INVALID"));
        }
        let mut tx = self.database.begin().await?;
        fence(&mut tx, workspace).await?;
        let prior: Option<(String,Uuid,String,Value)> = sqlx::query_as("SELECT workspace_id,reservation_id,body_hash,result FROM workspace_usage_receipts WHERE event_id=$1")
            .bind(event).fetch_optional(&mut *tx).await?;
        if let Some((saved_workspace, saved_reservation, saved_hash, mut result)) = prior {
            if saved_workspace != workspace
                || saved_reservation.to_string() != text(&value["reservationId"])?
                || saved_hash != body_hash
            {
                return Err(fail("USAGE_SETTLEMENT_CONFLICT"));
            }
            result["replayed"] = json!(true);
            tx.commit().await?;
            return Ok(result);
        }
        let held: Reservation = sqlx::query_as(
            "SELECT * FROM workspace_usage_reservations WHERE workspace_id=$1 AND id=$2",
        )
        .bind(workspace)
        .bind(reservation)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| fail("USAGE_RESERVATION_NOT_FOUND"))?;
        if !["held", "uncertain"].contains(&held.state.as_str()) {
            return Err(fail("USAGE_TERMINAL_RECONCILIATION_REQUIRED"));
        }
        let uncertain = outcome == "uncertain";
        let status = if uncertain {
            "uncertain"
        } else if outcome == "confirmed-no-charge" {
            "released"
        } else if cost > held.maximum_cost_usd_micros as u64 {
            "reconciliation-required"
        } else {
            "settled"
        };
        let settled = if uncertain { 0 } else { cost as i64 };
        let reserved = if uncertain {
            held.maximum_cost_usd_micros
        } else {
            0
        };
        let mut result =
            json!({"state":status,"settledUsdMicros":settled,"reservedUsdMicros":reserved});
        tx.prepare().await?;
        sqlx::query("UPDATE workspace_usage_reservations SET state=$2,settled_usd_micros=$3,reserved_usd_micros=$4,updated_at=$5 WHERE id=$1")
            .bind(held.id).bind(status).bind(settled).bind(reserved).bind(now()).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO workspace_usage_receipts(event_id,workspace_id,reservation_id,body_hash,result) VALUES($1,$2,$3,$4,$5)")
            .bind(event).bind(workspace).bind(held.id).bind(body_hash).bind(&result).execute(&mut *tx).await?;
        audit(
            &mut tx,
            workspace,
            None,
            "usage.agent.settled",
            &held.id.to_string(),
            text(&value["eventId"])?,
            result.clone(),
        )
        .await?;
        tx.commit().await?;
        result["replayed"] = json!(false);
        Ok(result)
    }
    /// Materializes the original period/carry shadow; never grants another pool.
    pub async fn inspect_usage(&self, workspace: &str) -> Result<Value, StoreError> {
        let mut tx = self.database.begin().await?;
        let (workspace, now) = fence(&mut tx, workspace).await?;
        tx.prepare().await?;
        let result = authority(&mut tx, &workspace, now).await?;
        tx.commit().await?;
        Ok(
            json!({"periodId":result.account.id,"kind":result.account.kind,"periodStart":stamp(result.account.started_at),
            "periodEnd":stamp(result.account.ends_at),"settledUsdMicros":result.settled,"reservedUsdMicros":result.reserved,"carrySourceCount":result.carry_count}),
        )
    }
}
