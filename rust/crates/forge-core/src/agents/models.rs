use super::*;
use crate::contract::*;
use serde_json::{Value, json};
const REFERENCE: &[&str] = &[
    "selectionId",
    "connectionId",
    "executionKind",
    "provider",
    "modelId",
];
fn reference_fields(o: &mut Object) -> Result<()> {
    for key in ["selectionId", "modelId"] {
        o.required(key, |v| text(v, 1, 255, true))?;
    }
    o.required("connectionId", uuid)?;
    o.required("executionKind", |v| enumeration(v, EXECUTIONS))?;
    o.required("provider", |v| text(v, 1, 100, true))?;
    Ok(())
}
pub fn reference(v: Value) -> Result<Value> {
    let mut o = Object::new(v, REFERENCE, true)?;
    reference_fields(&mut o)?;
    Ok(o.finish())
}
pub fn catalog(v: Value) -> Result<Value> {
    let keys = [
        REFERENCE,
        &[
            "displayName",
            "providerLabel",
            "sourceLabel",
            "locality",
            "billingMode",
            "inputModalities",
            "supportsTools",
            "supportsCode",
            "supportedReasoningEfforts",
            "contextWindowTokens",
            "status",
        ],
    ]
    .concat();
    let mut o = Object::new(v, &keys, true)?;
    reference_fields(&mut o)?;
    o.required("displayName", |v| text(v, 1, 255, true))?;
    for key in ["providerLabel", "sourceLabel"] {
        o.required(key, |v| text(v, 1, 100, true))?;
    }
    o.required("locality", |v| enumeration(v, LOCALITIES))?;
    o.required("billingMode", |v| enumeration(v, BILLING))?;
    o.required("inputModalities", |v| {
        list(v, 0, usize::MAX, |v| text(v, 1, 50, true))
    })?;
    for key in ["supportsTools", "supportsCode"] {
        o.required(key, boolean)?;
    }
    o.required("supportedReasoningEfforts", |v| {
        list(v, 0, usize::MAX, |v| enumeration(v, EFFORTS))
    })?;
    o.required("contextWindowTokens", |v| {
        nullable(v, |v| number(v, 1., 9007199254740991., true))
    })?;
    o.required("status", |v| {
        enumeration(v, &["available", "unavailable", "deprecated", "hidden"])
    })?;
    Ok(o.finish())
}
pub fn route(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "runtimeKind",
            "executionKind",
            "connectionId",
            "connectionLabel",
            "locality",
            "billingMode",
            "provider",
            "providerLabel",
            "modelId",
            "modelDisplayName",
            "reasoningEffort",
        ],
        true,
    )?;
    o.required("runtimeKind", |v| enumeration(v, RUNTIMES))?;
    o.required("executionKind", |v| enumeration(v, EXECUTIONS))?;
    o.required("connectionId", uuid)?;
    o.required("locality", |v| enumeration(v, LOCALITIES))?;
    o.required("billingMode", |v| enumeration(v, BILLING))?;
    for key in ["connectionLabel", "provider", "providerLabel"] {
        o.required(key, |v| text(v, 1, 100, true))?;
    }
    for key in ["modelId", "modelDisplayName"] {
        o.required(key, |v| text(v, 1, 255, true))?;
    }
    o.required("reasoningEffort", |v| enumeration(v, EFFORTS))?;
    Ok(o.finish())
}
pub fn resolved(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "requestedSelection",
            "model",
            "reasoningEffort",
            "routingPolicyVersion",
            "routingReason",
            "route",
        ],
        true,
    )?;
    o.required("requestedSelection", |v| text(v, 1, 255, true))?;
    o.required("model", reference)?;
    o.required("reasoningEffort", |v| enumeration(v, EFFORTS))?;
    o.required("routingPolicyVersion", |v| {
        nullable(v, |v| text(v, 1, 100, true))
    })?;
    o.required("routingReason", |v| nullable(v, |v| text(v, 1, 1000, true)))?;
    o.required("route", route)?;
    Ok(o.finish())
}
pub fn connection(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "id",
            "workspaceId",
            "userId",
            "scope",
            "provider",
            "kind",
            "executionKind",
            "locality",
            "billingMode",
            "credentialOwner",
            "displayName",
            "maskedCredentialSuffix",
            "endpointUrl",
            "status",
            "statusReason",
            "discoveredAt",
            "lastHealthCheckedAt",
            "createdAt",
            "updatedAt",
            "modelCount",
        ],
        true,
    )?;
    o.required("id", uuid)?;
    o.required("workspaceId", |v| text(v, 1, usize::MAX, false))?;
    for key in [
        "userId",
        "maskedCredentialSuffix",
        "endpointUrl",
        "statusReason",
    ] {
        o.required(key, |v| nullable(v, string))?;
    }
    o.required("scope", |v| enumeration(v, &["personal", "workspace"]))?;
    o.required("provider", |v| enumeration(v, PROVIDERS))?;
    o.required("kind", |v| {
        enumeration(
            v,
            &["managed", "api-key", "workload-identity", "local-agent"],
        )
    })?;
    o.required("executionKind", |v| enumeration(v, EXECUTIONS))?;
    o.required("locality", |v| enumeration(v, LOCALITIES))?;
    o.required("billingMode", |v| enumeration(v, BILLING))?;
    o.required("credentialOwner", |v| {
        enumeration(
            v,
            &[
                "forge-local-vault",
                "forge-server-vault",
                "provider-process",
            ],
        )
    })?;
    o.required("displayName", |v| text(v, 1, 100, false))?;
    o.required("status", |v| {
        enumeration(
            v,
            &[
                "ready",
                "login-required",
                "expired",
                "repair-required",
                "unavailable",
                "policy-blocked",
            ],
        )
    })?;
    for key in ["discoveredAt", "lastHealthCheckedAt"] {
        o.required(key, |v| nullable(v, datetime))?;
    }
    for key in ["createdAt", "updatedAt"] {
        o.required(key, datetime)?;
    }
    o.required("modelCount", integer)?;
    Ok(o.finish())
}
pub fn create_connection(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "provider",
            "scope",
            "displayName",
            "apiKey",
            "endpointUrl",
            "modelIds",
        ],
        true,
    )?;
    o.required("provider", |v| enumeration(v, PROVIDERS))?;
    o.default("scope", json!("personal"), |v| {
        enumeration(v, &["personal", "workspace"])
    })?;
    o.required("displayName", |v| text(v, 1, 100, true))?;
    o.required("apiKey", |v| text(v, 8, 10000, true))?;
    o.optional("endpointUrl", |v| text(url(v, false)?, 0, 2048, false))?;
    o.optional("modelIds", |v| list(v, 0, 100, |v| text(v, 1, 255, true)))?;
    let v = o.finish();
    if v["provider"].as_str().unwrap().starts_with("custom-") != v.get("endpointUrl").is_some() {
        return Err(ContractError("endpoint"));
    }
    Ok(v)
}
pub fn preference(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "mode",
            "selectedConnectionId",
            "selectedModelId",
            "selectedEffort",
        ],
        true,
    )?;
    o.required("mode", |v| enumeration(v, &["auto", "manual"]))?;
    o.required("selectedConnectionId", |v| nullable(v, uuid))?;
    o.required("selectedModelId", |v| {
        nullable(v, |v| text(v, 1, 255, true))
    })?;
    o.required("selectedEffort", |v| {
        nullable(v, |v| enumeration(v, EFFORTS))
    })?;
    let v = o.finish();
    if (v["mode"] == "auto" && !v["selectedModelId"].is_null())
        || (v["mode"] == "manual"
            && (v["selectedConnectionId"].is_null() || v["selectedModelId"].is_null()))
    {
        return Err(ContractError("selection"));
    }
    Ok(v)
}
pub fn connection_action(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["action"], true)?;
    o.required("action", |v| enumeration(v, &["refresh", "test"]))?;
    Ok(o.finish())
}
