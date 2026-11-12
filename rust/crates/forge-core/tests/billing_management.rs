use forge_core::{
    actor::Actor,
    billing::{
        self, Error,
        management::{self as rules, ManagementContext, Prepared},
    },
};
use serde_json::Value;
use std::sync::LazyLock;
static FIXTURES: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../data/billing-management-reference.json")).unwrap()
});
fn evaluate(kind: &str, input: &Value, ctx: &Value) -> Result<Value, Error> {
    let context: ManagementContext = serde_json::from_value(ctx.clone()).unwrap();
    match kind {
        "refund-context" => rules::refund_renewal_context(&input["value"], &context.base.previous),
        "refund-confirmation" => Prepared::refund_renewal(&input["value"], &input["proof"])
            .and_then(|p| p.plan(&context))
            .map(|p| serde_json::to_value(p).unwrap()),
        _ => {
            let actor: Actor = serde_json::from_value(input["actor"].clone()).unwrap();
            match kind {
                "members" => {
                    billing::identity(&actor)?;
                    Ok(serde_json::json!(billing::safe_integer(
                        &ctx["memberCount"],
                        1
                    )?))
                }
                "cancellation" => rules::cancellation_context(
                    &actor,
                    input["environment"].as_str().unwrap(),
                    context.base.member_role.as_deref(),
                    &context.base.previous,
                ),
                "plan-change" => rules::plan_change_context(
                    &actor,
                    input["environment"].as_str().unwrap(),
                    context.base.member_role.as_deref(),
                    &context.base.previous,
                    &context.capacity,
                    context.base.now,
                ),
                "currency" => Prepared::currency(&actor, &input["value"])
                    .and_then(|p| p.plan(&context))
                    .map(|p| serde_json::to_value(p).unwrap()),
                _ => panic!("unknown source operation"),
            }
        }
    }
}
fn check(kinds: &[&str]) {
    let mut failures = vec![];
    let mut count = 0;
    for (index, case) in FIXTURES["cases"].as_array().unwrap().iter().enumerate() {
        let kind = case["kind"].as_str().unwrap();
        if !kinds.contains(&kind) {
            continue;
        }
        count += 1;
        let actual = evaluate(kind, &case["input"], &case["context"]);
        let matches = match &actual {
            Ok(value) => case["valid"] == true && value == &case["output"],
            Err(error) => case["valid"] == false && case["error"] == error.0,
        };
        if !matches {
            failures.push(format!("case {index} {kind}: input {} context {}; expected {}, error {}, actual {actual:?}",case["input"],case["context"],case["output"],case["error"]));
        }
    }
    assert!(count > 0);
    assert!(
        failures.is_empty(),
        "{} source mismatches (first ten):\n{}",
        failures.len(),
        failures
            .iter()
            .take(10)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
#[test]
fn billing_management_contexts_recheck_membership_paid_access_and_refund_binding() {
    check(&["members", "cancellation", "plan-change", "refund-context"]);
}
#[test]
fn refund_renewal_confirmation_never_grants_access_and_preserves_revision_receipts() {
    check(&["refund-confirmation"]);
}
#[test]
fn currency_intents_preserve_server_country_seats_original_anniversary_and_live_replay_authority() {
    check(&["currency"]);
}
