use super::*;
pub fn refund_identity(raw: &Value) -> Result<Value> {
    let workspace = string(&raw["workspaceId"])?;
    if workspace.is_empty() {
        return Err(invalid());
    }
    Ok(
        json!({"workspaceId":workspace,"environment":choice(&raw["environment"],&["sandbox","production"] )?,"subscriptionId":uuid(&raw["subscriptionId"] )?,"orderId":uuid(&raw["orderId"] )?}),
    )
}
pub fn refund_renewal_context(value: &Value, state: &Value) -> Result<Value> {
    let input = refund_identity(value)?;
    let marker = state["refundedPeriods"]
        .as_array()
        .and_then(|ps| {
            ps.iter().find(|p| {
                p["kind"] == "upgrade"
                    && p["environment"] == input["environment"]
                    && p["subscriptionId"] == input["subscriptionId"]
                    && p["orderId"] == input["orderId"]
            })
        })
        .ok_or(Error("BILLING_VERIFIED_UPGRADE_REFUND_REQUIRED"))?;
    if state["source"] != "polar" {
        return Err(Error("BILLING_REFUND_BINDING_REQUIRED"));
    }
    if state["providerEnvironment"] != input["environment"]
        || state["sourceReference"] != input["subscriptionId"]
    {
        return Ok(json!({"status":"superseded"}));
    }
    if present(&state["terminatedAt"]) {
        return Ok(json!({"status":"terminated"}));
    }
    if present(&state["unsupportedPauseAt"]) {
        return Err(Error("BILLING_SUBSCRIPTION_PAUSE_UNSUPPORTED"));
    }
    if present(&state["paidUpgradeOrderId"]) && state["paidUpgradeOrderId"] != input["orderId"] {
        return Ok(json!({"status":"superseded"}));
    }
    let (Ok(start), Ok(end)) = (
        date(&state["currentPeriodStart"]),
        date(&state["currentPeriodEnd"]),
    ) else {
        return Err(Error("BILLING_REFUND_BINDING_REQUIRED"));
    };
    let (Ok(refund_start), Ok(refund_end)) = (date(&marker["start"]), date(&marker["end"])) else {
        return Err(Error("BILLING_REFUND_RENEWAL_PERIOD_CONFLICT"));
    };
    if refund_start >= refund_end {
        return Err(Error("BILLING_REFUND_RENEWAL_PERIOD_CONFLICT"));
    }
    if start >= refund_end {
        return Ok(json!({"status":"superseded"}));
    }
    if start > refund_start || end != refund_end {
        return Err(Error("BILLING_REFUND_RENEWAL_PERIOD_CONFLICT"));
    }
    let start = stamp(start);
    let end = stamp(end);
    let mut revision = input;
    extend(
        &mut revision,
        &json!({"start":start,"end":end,"refundedAt":marker["refundedAt"],"paidOrder":state["paidUpgradeOrderId"],"terminatedAt":state["terminatedAt"]}),
    );
    Ok(json!({"status":"required","start":start,"end":end,"revision":hash(&revision)}))
}
pub(super) fn prepare(value: &Value, proof: &Value) -> Result<Prepared> {
    let input = refund_identity(value)?;
    let revision = string(&proof["revision"])?;
    if revision.len() != 64
        || !revision
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid());
    }
    let proof = json!({"revision":revision,"effectiveAt":iso(&proof["effectiveAt"] )?,"providerUpdatedAt":iso(&proof["providerUpdatedAt"] )?,"currency":choice(&proof["currency"],&["eur","usd"] )?,"productId":uuid(&proof["productId"] )?,"billedSeats":safe_integer(&proof["billedSeats"],1)?,"renewalSeats":safe_integer(&proof["renewalSeats"],1)?,"status":choice(&proof["status"],&["scheduled","already-starter"] )?});
    let event_id = format!(
        "forge.refund-renewal.{}.{}.{}",
        string(&input["orderId"])?,
        string(&proof["providerUpdatedAt"])?,
        proof["renewalSeats"]
    );
    let mut body = input.clone();
    extend(&mut body, &proof);
    Ok(Prepared {
        workspace: string(&input["workspaceId"])?.into(),
        environment: string(&input["environment"])?.into(),
        subscription: string(&input["subscriptionId"])?.into(),
        event_id,
        body_hash: hash(&body),
        actor: None,
        kind: Kind::RefundRenewal,
        value: input,
        proof,
    })
}
pub(super) fn plan(p: &Prepared, ctx: &ManagementContext) -> Result<Plan> {
    let current = refund_renewal_context(&p.value, &ctx.base.previous)?;
    if current["status"] != "required" {
        return Ok(Plan {
            commands: vec![],
            answer: json!({"status":current["status"],"replayed":false}),
        });
    }
    if current["revision"] != p.proof["revision"]
        || current["end"] != instant(&p.proof["effectiveAt"])?
    {
        return Err(Error("BILLING_REFUND_RENEWAL_CONTEXT_CHANGED"));
    }
    let replayed = p.check_receipt(&ctx.base.receipt)?;
    let mut commands = vec![];
    if !replayed {
        let mut after = p.proof.clone();
        extend(
            &mut after,
            &json!({"target":"starter","subscriptionId":p.subscription}),
        );
        commands.push(Command::AuditInsert{values:json!({"workspaceId":p.workspace,"action":"billing.upgrade_refund.renewal_confirmed","target":p.value["orderId"],"outcome":"succeeded","requestId":p.event_id,"after":after})});
        commands.push(p.receipt("applied"));
    }
    Ok(Plan {
        commands,
        answer: json!({"status":p.proof["status"],"replayed":replayed}),
    })
}
