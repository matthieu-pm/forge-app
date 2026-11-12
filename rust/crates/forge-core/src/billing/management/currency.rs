use super::*;
use chrono::Duration;
pub(super) fn prepare(actor: &Actor, raw: &Value) -> Result<Prepared> {
    identity(actor)?;
    let workspace = string(&raw["workspaceId"])?;
    if workspace.is_empty() {
        return Err(invalid());
    }
    let input = json!({"requestId":uuid(&raw["requestId"] )?,"workspaceId":workspace,"environment":choice(&raw["environment"],&["sandbox","production"] )?,"subscriptionId":uuid(&raw["subscriptionId"] )?,"billingCountry":country(&raw["billingCountry"])?["country"],"fromCurrency":choice(&raw["fromCurrency"],&["eur","usd"] )?,"currentPlan":choice(&raw["currentPlan"],&["starter","plus"] )?,"renewalPlan":choice(&raw["renewalPlan"],&["starter","plus"] )?,"periodStart":instant(&raw["periodStart"] )?,"periodEnd":instant(&raw["periodEnd"] )?,"providerUpdatedAt":instant(&raw["providerUpdatedAt"] )?});
    if actor.workspace_id != workspace {
        return Err(Error("BILLING_ACTOR_WORKSPACE_MISMATCH"));
    }
    if !before(&input["periodStart"], &input["periodEnd"]) {
        return Err(Error("BILLING_CURRENCY_PERIOD_INVALID"));
    }
    let anchor = calendar::capture(date(&input["periodStart"])?, date(&input["periodEnd"])?)?;
    let mut body = input.clone();
    body.as_object_mut()
        .unwrap()
        .shift_remove("providerUpdatedAt");
    body["actorUserId"] = json!(actor.user_id);
    Ok(Prepared {
        workspace: workspace.into(),
        environment: string(&input["environment"])?.into(),
        subscription: string(&input["subscriptionId"])?.into(),
        event_id: format!("forge.currency-request.{}", string(&input["requestId"])?),
        body_hash: hash(&body),
        actor: Some(actor.clone()),
        kind: Kind::CurrencyRequest,
        value: input,
        proof: anchor,
    })
}
fn answer(row: &Value, replayed: bool) -> Value {
    json!({"id":row["id"],"status":if row["state"]=="requested"{json!("requires-checkout")}else{row["state"].clone()},"fromCurrency":row["fromCurrency"],"targetCurrency":row["targetCurrency"],"billingCountry":row["billingCountry"],"effectiveAt":row["effectiveAt"],"checkoutGraceEndsAt":row["checkoutGraceEndsAt"],"renewalPlan":row["renewalPlan"],"renewalMembers":row["renewalMembers"],"renewalPriceMinor":row["renewalPriceMinor"],"providerChangeScheduled":false,"billingAnchorDay":row["billingAnchorDay"],"nextRenewalAt":row["nextRenewalAt"],"replayed":replayed})
}
pub(super) fn plan(p: &Prepared, ctx: &ManagementContext) -> Result<Plan> {
    live_member(ctx.base.member_role.as_deref())?;
    let input = &p.value;
    let state = &ctx.base.previous;
    let anchor = &p.proof;
    let parsed = SubscriptionState::from_json(state.clone());
    let access = subscription_access(parsed.as_ref(), Some(ctx.base.now));
    let plan = serde_json::to_value(access.plan).expect("plan");
    if state["source"] != "polar"
        || state["providerEnvironment"] != input["environment"]
        || state["sourceReference"] != input["subscriptionId"]
        || present(&state["unsupportedPauseAt"])
        || access.phase != AccessPhase::Paid
        || plan
            != if input["currentPlan"] == "starter" {
                "basic"
            } else {
                "business"
            }
        || date(&state["currentPeriodStart"]).ok() != date(&input["periodStart"]).ok()
        || date(&state["currentPeriodEnd"]).ok() != date(&input["periodEnd"]).ok()
        || before(&input["providerUpdatedAt"], &state["providerUpdatedAt"])
    {
        return Err(Error("BILLING_CURRENCY_CONTEXT_CHANGED"));
    }
    let mut commands = vec![];
    if p.check_receipt(&ctx.base.receipt)? {
        let mut row = ctx.requested.clone();
        if row.is_null() || row["workspaceId"] != input["workspaceId"] {
            return Err(Error("BILLING_CURRENCY_RECEIPT_INCOMPLETE"));
        }
        if row["originalPeriodStart"].is_null() {
            let set = json!({"originalPeriodStart":input["periodStart"],"billingAnchorDay":anchor["anchorDay"],"nextRenewalAt":anchor["nextRenewalAt"],"updatedAt":stamp(ctx.base.now)});
            commands.push(Command::CurrencyUpdate {
                id: row["id"].clone(),
                set: set.clone(),
            });
            extend(&mut row, &set);
            commands.push(Command::AuditInsert{values:json!({"workspaceId":p.workspace,"actorUserId":p.actor.as_ref().unwrap().user_id,"action":"billing.currency_change.anchor_captured","target":row["id"],"outcome":"succeeded","requestId":format!("forge.currency-anchor.{}",string(&row["id"] )?),"after":{"originalPeriodStart":row["originalPeriodStart"],"billingAnchorDay":row["billingAnchorDay"],"nextRenewalAt":row["nextRenewalAt"]}})});
        } else if date(&row["originalPeriodStart"]).ok() != date(&input["periodStart"]).ok()
            || row["billingAnchorDay"] != anchor["anchorDay"]
            || date(&row["nextRenewalAt"]).ok() != date(&anchor["nextRenewalAt"]).ok()
        {
            return Err(Error("BILLING_ANCHOR_RECONCILIATION_REQUIRED"));
        }
        return Ok(Plan {
            commands,
            answer: answer(&row, true),
        });
    }
    let pending = &ctx.pending;
    if !pending.is_null()
        && (pending["subscriptionId"] != input["subscriptionId"]
            || pending["environment"] != input["environment"]
            || date(&pending["effectiveAt"]).ok() != date(&input["periodEnd"]).ok())
    {
        return Err(Error("BILLING_CURRENCY_REQUEST_RECONCILIATION_REQUIRED"));
    }
    if ctx.capacity.is_null() {
        return Err(Error("BILLING_MEMBER_CAPACITY_REQUIRED"));
    }
    if !pending.is_null() {
        commands.push(Command::CurrencyUpdate {
            id: pending["id"].clone(),
            set: json!({"state":"superseded","updatedAt":stamp(ctx.base.now)}),
        });
    }
    let target = country(&input["billingCountry"])?["currency"].clone();
    let status = if target != input["fromCurrency"] {
        "requested"
    } else if !pending.is_null() {
        "withdrawn"
    } else {
        "unchanged"
    };
    let values = json!({"id":input["requestId"],"workspaceId":p.workspace,"actorUserId":p.actor.as_ref().unwrap().user_id,"environment":p.environment,"subscriptionId":p.subscription,"billingCountry":input["billingCountry"],"fromCurrency":input["fromCurrency"],"targetCurrency":target,"currentPlan":input["currentPlan"],"renewalPlan":input["renewalPlan"],"renewalMembers":ctx.capacity["activeMemberCount"],"renewalPriceMinor":evaluate("price",&json!({"plan":input["renewalPlan"],"members":ctx.capacity["activeMemberCount"]})).map_err(|e|if e.0=="BILLING_INTEGER_OVERFLOW"{Error("Workspace price exceeds the supported range.")}else{e})?,"effectiveAt":input["periodEnd"],"originalPeriodStart":input["periodStart"],"billingAnchorDay":anchor["anchorDay"],"nextRenewalAt":anchor["nextRenewalAt"],"checkoutGraceEndsAt":stamp(date(&input["periodEnd"] )?+Duration::days(7)),"state":status});
    commands.push(Command::CurrencyInsert {
        values: values.clone(),
    });
    // INSERT ... RETURNING canonicalizes UUID columns in the owning database.
    let mut row = values;
    row["id"] = json!(string(&row["id"])?.to_ascii_lowercase());
    commands.push(Command::AuditInsert{values:json!({"workspaceId":p.workspace,"actorUserId":p.actor.as_ref().unwrap().user_id,"action":"billing.currency_change.requested","target":row["id"],"outcome":"succeeded","requestId":p.event_id,"after":{"fromCurrency":row["fromCurrency"],"targetCurrency":row["targetCurrency"],"billingCountry":row["billingCountry"],"effectiveAt":row["effectiveAt"],"billingAnchorDay":row["billingAnchorDay"],"nextRenewalAt":row["nextRenewalAt"],"checkoutGraceEndsAt":row["checkoutGraceEndsAt"],"state":row["state"],"providerChangeScheduled":false}})});
    commands.push(p.receipt(if status == "unchanged" {
        "unchanged"
    } else {
        "applied"
    }));
    Ok(Plan {
        commands,
        answer: answer(&row, false),
    })
}
