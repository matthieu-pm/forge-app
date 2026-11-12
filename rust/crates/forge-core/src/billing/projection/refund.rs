use super::*;
pub(super) fn parse(raw: &Value) -> Result<Value> {
    let kind = choice(
        raw.get("kind").unwrap_or(&json!("full")),
        &["full", "partial"],
    )?
    .to_owned();
    let scope = choice(
        raw.get("scope").unwrap_or(&json!("period")),
        &["period", "upgrade"],
    )?
    .to_owned();
    let mut v = json!({"kind":kind,"scope":scope});
    if let Some(b) = raw.get("starterBasis") {
        v["starterBasis"] = json!({"orderId":uuid(&b["orderId"] )?,"start":iso(&b["start"] )?,"end":iso(&b["end"] )?});
    }
    extend(
        &mut v,
        &json!({"workspaceId":raw["workspaceId"],"environment":raw["environment"],"orderId":uuid(&raw["orderId"] )?,"subscriptionId":raw["subscriptionId"],"start":iso(&raw["start"] )?,"end":iso(&raw["end"] )?,"refundedAt":iso(&raw["refundedAt"] )?}),
    );
    if !before(&v["start"], &v["end"]) {
        return Err(Error("BILLING_REFUND_PERIOD_INVALID"));
    }
    if let Some(b) = v.get("starterBasis")
        && (scope != "upgrade"
            || before(&v["start"], &b["start"])
            || !before(&b["start"], &b["end"])
            || date(&b["end"])? != date(&v["end"])?)
    {
        return Err(Error("BILLING_STARTER_BASE_INVALID"));
    }
    Ok(v)
}
pub(super) fn plan(b: &mut Builder<'_>) -> Result<Plan> {
    let v = &b.event.value;
    let previous = &b.context.previous;
    let history = previous["refundedPeriods"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let existing = history
        .iter()
        .position(|p| p["environment"] == v["environment"] && p["orderId"] == v["orderId"]);
    let basis = &v["starterBasis"];
    let upgrade = v["scope"] == "upgrade";
    if let Some(index) = existing {
        let p = &history[index];
        if p["subscriptionId"] != v["subscriptionId"]
            || p["start"] != v["start"]
            || p["end"] != v["end"]
            || (p["kind"] == "upgrade") != upgrade
            || (present(&p["starterOrderId"])
                && present(basis)
                && p["starterOrderId"] != basis["orderId"])
        {
            return Err(Error("BILLING_REFUND_CONFLICT"));
        }
    }
    let restore = upgrade
        && v["kind"] == "full"
        && present(basis)
        && existing.is_some_and(|i| !present(&history[i]["starterOrderId"]));
    let change = v["kind"] == "full" && (existing.is_none() || restore);
    if !b.context.receipt.is_null() && !change {
        return b.finish(b.context.receipt["outcome"].clone(), false);
    }
    // This field order is also the source's frozen marker order.
    let refund = json!({"environment":v["environment"],"orderId":v["orderId"],"subscriptionId":v["subscriptionId"],"start":v["start"],"end":v["end"],"refundedAt":v["refundedAt"]});
    if change {
        let mut marker = refund.clone();
        if upgrade {
            marker["kind"] = json!("upgrade");
            marker["starterOrderId"] = basis["orderId"].clone();
            if present(basis) {
                marker["basePeriodStart"] = basis["start"].clone();
                marker["basePeriodEnd"] = basis["end"].clone();
            }
        }
        let mut history = history;
        if let Some(i) = existing {
            history[i] = marker
        } else {
            history.push(marker)
        }
        let mut set = json!({"refundedPeriods":history,"updatedAt":stamp(b.context.now)});
        if upgrade
            && previous["source"] == "polar"
            && previous["providerEnvironment"] == v["environment"]
            && previous["sourceReference"] == v["subscriptionId"]
            && before(&v["start"], &previous["currentPeriodEnd"])
            && before(&previous["currentPeriodStart"], &v["end"])
            && (!present(&previous["paidUpgradeOrderId"])
                || previous["paidUpgradeOrderId"] == v["orderId"])
        {
            extend(&mut set, &json!({"plan":"basic","paidUpgradeOrderId":null}));
        }
        b.upsert(
            json!({"workspaceId":b.event.workspace,"refundedPeriods":history}),
            set,
        );
    }
    let v = &b.event.value;
    if change || v["kind"] == "partial" {
        let mut after = refund;
        extend(
            &mut after,
            &json!({"kind":v["kind"],"scope":v["scope"],"starterBasis":v["starterBasis"]}),
        );
        b.emit(Command::AuditInsert {values:json!({"workspaceId":b.event.workspace,"action":if v["kind"]=="partial"{"billing.subscription_period.partially_refunded"}else if upgrade{"billing.upgrade_charge.refunded"}else{"billing.subscription_period.refunded"},"target":v["orderId"],"outcome":"succeeded","after":after,"requestId":b.event.event_id})});
    }
    b.finish(json!(if change { "applied" } else { "unchanged" }), true)
}
