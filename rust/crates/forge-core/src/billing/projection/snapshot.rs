use super::*;
use chrono::Duration;

type Parsed = (Value, Option<Value>, Option<Actor>);
pub(super) fn parse(input: &Value) -> Result<Parsed> {
    let raw = &input["snapshot"];
    // Preserve the Zod declaration order for the historical provider state hash.
    let mut v = json!({"workspaceId":raw["workspaceId"],"environment":raw["environment"],"subscriptionId":raw["subscriptionId"],"plan":choice(&raw["plan"],&["starter","plus"] )?,"status":choice(&raw["status"],&["active","past_due","canceled"] )?,"updatedAt":instant(&raw["updatedAt"] )?,"currentPeriodStart":instant(&raw["currentPeriodStart"] )?,"currentPeriodEnd":instant(&raw["currentPeriodEnd"] )?,"pastDueAt":nullable_date(&required(raw,"pastDueAt")?)?,"cancelAtPeriodEnd":raw.get("cancelAtPeriodEnd").map_or(Ok(false),|v|v.as_bool().ok_or_else(invalid))?,"terminatedAt":nullable_date(&raw["terminatedAt"] )?,"unsupportedPauseAt":nullable_date(&raw["unsupportedPauseAt"] )?});
    if let Some(p) = raw.get("paidUpgrade") {
        v["paidUpgrade"] = json!({"orderId":uuid(&p["orderId"] )?,"subscriptionId":uuid(&p["subscriptionId"] )?,"periodStart":instant(&p["periodStart"] )?,"periodEnd":instant(&p["periodEnd"] )?,"createdAt":instant(&p["createdAt"] )?});
    }
    let plan_change=input.get("planChange").filter(|v|!v.is_null()).map(|p|->Result<Value>{Ok(json!({"target":choice(&p["target"],&["starter","plus"] )?,"status":choice(&p["status"],&["applied","scheduled","unchanged","payment-pending","cleared"] )?,"effectiveAt":nullable_date(&required(p,"effectiveAt")?)?,"renewalSeats":safe_integer(&p["renewalSeats"],1)?}))}).transpose()?;
    let actor = input
        .get("actor")
        .filter(|v| !v.is_null())
        .map(|a| serde_json::from_value::<Actor>(a.clone()).map_err(|_| invalid()))
        .transpose()?;
    if plan_change.is_some() && actor.is_none() {
        return Err(Error("BILLING_ACTOR_REQUIRED"));
    }
    if let Some(a) = &actor
        && identity(a)?["workspaceId"] != v["workspaceId"]
    {
        return Err(Error("BILLING_ACTOR_WORKSPACE_MISMATCH"));
    }
    let paid = &v["paidUpgrade"];
    if !before(&v["currentPeriodStart"], &v["currentPeriodEnd"])
        || (present(paid)
            && ((v["status"] != "active"
                && !(v["status"] == "canceled" && v["cancelAtPeriodEnd"] == true))
                || present(&v["terminatedAt"])
                || present(&v["unsupportedPauseAt"])
                || v["plan"] != "plus"
                || paid["subscriptionId"] != v["subscriptionId"]
                || paid["periodStart"] != v["currentPeriodStart"]
                || paid["periodEnd"] != v["currentPeriodEnd"]
                || before(&paid["createdAt"], &v["currentPeriodStart"])
                || !before(&paid["createdAt"], &v["currentPeriodEnd"])))
        || (present(&v["terminatedAt"])
            && (v["status"] != "canceled" || before(&v["updatedAt"], &v["terminatedAt"])))
        || (present(&v["unsupportedPauseAt"])
            && before(&v["updatedAt"], &v["unsupportedPauseAt"])
            && v["unsupportedPauseAt"] != v["currentPeriodEnd"])
        || (v["status"] == "canceled"
            && v["cancelAtPeriodEnd"] != true
            && !present(&v["terminatedAt"]))
        || (v["status"] == "past_due"
            && (!present(&v["pastDueAt"]) || before(&v["updatedAt"], &v["pastDueAt"])))
    {
        return Err(Error("BILLING_SNAPSHOT_INVALID"));
    }
    Ok((v, plan_change, actor))
}
fn legacy(v: &Value) -> Value {
    let mut out = json!({});
    for key in [
        "workspaceId",
        "environment",
        "subscriptionId",
        "plan",
        "status",
        "updatedAt",
        "currentPeriodStart",
        "currentPeriodEnd",
        "pastDueAt",
    ] {
        out[key] = v[key].clone();
    }
    out
}
pub(super) fn plan(b: &mut Builder<'_>) -> Result<Plan> {
    let v = &b.event.value;
    let p = &b.context.previous;
    let same = p["source"] == "polar"
        && p["sourceReference"] == v["subscriptionId"]
        && p["providerEnvironment"] == v["environment"];
    if p["source"] == "polar" && !same {
        return Err(Error("BILLING_SUBSCRIPTION_CONFLICT"));
    }
    let legacy = legacy(v);
    let mut hashed = legacy.clone();
    if v["cancelAtPeriodEnd"] == true {
        hashed["cancelAtPeriodEnd"] = json!(true);
    }
    if present(&v["terminatedAt"]) {
        hashed["terminatedAt"] = v["terminatedAt"].clone();
    }
    let state_hash = hash(&hashed);
    let storage_plan = if v["plan"] == "starter" {
        "basic"
    } else {
        "business"
    };
    if present(&v["terminatedAt"]) {
        let earlier = if same {
            p["terminatedAt"].clone()
        } else {
            Value::Null
        };
        let cutoff = earliest(&earlier, &v["terminatedAt"]);
        let changed = !present(&earlier) || before(&cutoff, &earlier);
        if !changed && !b.context.receipt.is_null() {
            return b.finish(b.context.receipt["outcome"].clone(), false);
        }
        if changed {
            if same {
                b.emit(Command::EntitlementUpdate {
                    set: json!({"terminatedAt":cutoff,"updatedAt":stamp(b.context.now)}),
                });
            } else {
                let set = json!({"plan":storage_plan,"status":"canceled","source":"polar","sourceReference":v["subscriptionId"],"providerEnvironment":v["environment"],"providerUpdatedAt":v["updatedAt"],"providerStateHash":state_hash,"currentPeriodStart":v["currentPeriodStart"],"currentPeriodEnd":v["currentPeriodEnd"],"terminatedAt":cutoff,"cancelAtPeriodEnd":false,"cancellationPeriodEnd":null,"paidActivatedAt":null,"paymentFailedAt":null,"graceExpiresAt":null,"updatedAt":stamp(b.context.now)});
                let mut values = json!({"workspaceId":b.event.workspace});
                extend(&mut values, &set);
                b.upsert(values, set);
            }
            b.audit(
                "billing.subscription.terminated",
                json!({"terminatedAt":cutoff,"normalizedStatus":b.event.value["status"]}),
            );
        }
        return b.finish(json!(if changed { "applied" } else { "unchanged" }), true);
    }
    if present(&v["unsupportedPauseAt"]) {
        let earlier = if same {
            p["unsupportedPauseAt"].clone()
        } else {
            Value::Null
        };
        let cutoff = earliest(&earlier, &v["unsupportedPauseAt"]);
        let changed = !present(&earlier) || before(&cutoff, &earlier);
        if same && present(&p["terminatedAt"]) {
            return b.finish(json!("unchanged"), true);
        }
        if changed {
            if same {
                b.emit(Command::EntitlementUpdate {
                    set: json!({"unsupportedPauseAt":cutoff,"updatedAt":stamp(b.context.now)}),
                });
            } else {
                b.emit(Command::EntitlementInsert{values:json!({"workspaceId":b.event.workspace,"source":"polar","sourceReference":v["subscriptionId"],"providerEnvironment":v["environment"],"providerUpdatedAt":v["updatedAt"],"providerStateHash":state_hash,"plan":storage_plan,"status":v["status"],"currentPeriodStart":v["currentPeriodStart"],"currentPeriodEnd":v["currentPeriodEnd"],"unsupportedPauseAt":cutoff})});
            }
            b.audit(
                "billing.subscription.unsupported_pause",
                json!({"unsupportedPauseAt":cutoff}),
            );
        }
        return b.finish(json!(if changed { "applied" } else { "unchanged" }), true);
    }
    let paid = &v["paidUpgrade"];
    let usable = present(paid)
        && !p["refundedPeriods"].as_array().is_some_and(|periods| {
            periods.iter().any(|r| {
                r["kind"] == "upgrade"
                    && r["environment"] == v["environment"]
                    && r["orderId"] == paid["orderId"]
            })
        });
    let promotion = same
        && !present(&p["terminatedAt"])
        && !present(&p["unsupportedPauseAt"])
        && p["plan"] == "basic"
        && v["plan"] == "plus"
        && (v["status"] == "active"
            || (v["status"] == "canceled" && v["cancelAtPeriodEnd"] == true))
        && usable;
    if !b.context.receipt.is_null() && !promotion {
        return b.finish(b.context.receipt["outcome"].clone(), false);
    }
    if same && present(&p["terminatedAt"]) {
        return b.finish(json!("unchanged"), true);
    }
    let mut outcome = "applied";
    if same && present(&p["providerUpdatedAt"]) {
        let version = date(&v["updatedAt"])?.cmp(&date(&p["providerUpdatedAt"])?);
        if version.is_lt() {
            outcome = "stale";
        }
        if version.is_eq() {
            let expansion = v["cancelAtPeriodEnd"] == true
                && p["cancelAtPeriodEnd"] != true
                && !present(&p["cancellationPeriodEnd"])
                && p["providerStateHash"] == hash(&legacy);
            if p["providerStateHash"] != state_hash && !expansion {
                return Err(Error("BILLING_VERSION_CONFLICT"));
            }
            outcome = if expansion || promotion {
                "applied"
            } else {
                "unchanged"
            };
        }
    }
    if outcome == "applied" {
        let invalidated = same
            && v["status"] == "past_due"
            && SubscriptionState::from_json(p.clone()).is_some_and(|s| s.is_refunded());
        let activated = if same && !invalidated {
            p["paidActivatedAt"].clone()
        } else {
            Value::Null
        };
        let status = if v["status"] == "canceled" && same && p["status"] == "past_due" {
            json!("past_due")
        } else {
            v["status"].clone()
        };
        let candidate = if v["status"] == "canceled" && same {
            p["paymentFailedAt"].clone()
        } else {
            v["pastDueAt"].clone()
        };
        let earlier = if same && p["status"] == "past_due" {
            p["paymentFailedAt"].clone()
        } else {
            Value::Null
        };
        let failure = if present(&earlier) && present(&candidate) {
            earliest(&earlier, &candidate)
        } else {
            candidate
        };
        let grace = status == "past_due" && before(&activated, &failure);
        let cancel = v["cancelAtPeriodEnd"] == true || v["status"] == "canceled";
        let cancellation = if cancel {
            earliest(
                if same {
                    &p["cancellationPeriodEnd"]
                } else {
                    &Value::Null
                },
                &v["currentPeriodEnd"],
            )
        } else {
            Value::Null
        };
        let mut set = json!({"plan":storage_plan,"status":status,"source":"polar","sourceReference":v["subscriptionId"],"providerEnvironment":v["environment"],"providerUpdatedAt":v["updatedAt"],"providerStateHash":state_hash,"currentPeriodStart":v["currentPeriodStart"],"currentPeriodEnd":v["currentPeriodEnd"],"cancelAtPeriodEnd":cancel,"cancellationPeriodEnd":cancellation,"paidActivatedAt":if v["status"]=="active"&&!present(&activated){&v["updatedAt"]}else{&activated},"paymentFailedAt":if grace{failure.clone()}else{Value::Null},"graceExpiresAt":if grace{json!(stamp(date(&failure)?+Duration::days(7)))}else{Value::Null},"updatedAt":stamp(b.context.now)});
        let unpaid = same && p["plan"] == "basic" && v["plan"] == "plus" && !usable;
        let early = same
            && p["plan"] == "business"
            && v["plan"] == "starter"
            && before(&v["currentPeriodStart"], &p["currentPeriodEnd"]);
        if unpaid || early {
            for key in [
                "plan",
                "status",
                "paidActivatedAt",
                "currentPeriodStart",
                "currentPeriodEnd",
                "cancelAtPeriodEnd",
                "cancellationPeriodEnd",
                "paymentFailedAt",
                "graceExpiresAt",
            ] {
                set[key] = p[key].clone();
            }
        }
        set["paidUpgradeOrderId"] = if set["plan"] == "business" {
            if usable {
                paid["orderId"].clone()
            } else if same {
                p["paidUpgradeOrderId"].clone()
            } else {
                Value::Null
            }
        } else {
            Value::Null
        };
        let after = json!({"plan":set["plan"],"status":set["status"],"providerStatus":v["status"],"upgradePaymentPending":unpaid,"earlyDowngradeDeferred":early,"paidUpgradeOrderId":set["paidUpgradeOrderId"],"cancellationPeriodEnd":set["cancellationPeriodEnd"],"graceExpiresAt":set["graceExpiresAt"]});
        let mut values = json!({"workspaceId":b.event.workspace});
        extend(&mut values, &set);
        b.upsert(values, set);
        b.audit("billing.entitlements.reconciled", after);
    }
    if let Some(change) = &b.event.plan_change
        && outcome != "stale"
    {
        let pending = change["target"] == "plus" && b.effective_plan() != "business";
        let mut after = change.clone();
        if pending {
            after["status"] = json!("payment-pending");
            after["effectiveAt"] = Value::Null;
        }
        b.audit("billing.plan_change.confirmed", after);
    }
    b.finish(json!(outcome), true)
}
