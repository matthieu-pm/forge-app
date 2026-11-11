use super::*;
pub(super) async fn handle(settings: &Settings, request: Request, capability: &str) -> Response {
    if request.method() != Method::POST {
        return json_response(json!({"error":{"code":"METHOD_NOT_ALLOWED"}}), 405);
    }
    let Some(token) = header(request.headers(), "authorization")
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(forge_core::text::trim)
        .filter(|s| !s.is_empty())
    else {
        return missing();
    };
    let Some(run) = header(request.headers(), "x-forge-agent-run-id").filter(|s| !s.is_empty())
    else {
        return missing();
    };
    let Some(workspace) =
        header(request.headers(), "x-forge-workspace-id").filter(|s| !s.is_empty())
    else {
        return missing();
    };
    let Ok(actor) = tokens::verify_capability(
        &settings.capability_secret,
        token,
        run,
        workspace,
        capability,
        (settings.now)(),
    ) else {
        return rejected();
    };
    let Ok(run) = id(run) else { return rejected() };
    let Ok(input) = body(request).await else {
        return rejected();
    };
    let mut invocation = json!({"capabilityId":capability});
    for (input_key, key) in [
        ("version", "capabilityVersion"),
        ("input", "input"),
        ("idempotencyKey", "idempotencyKey"),
        ("approvalId", "approvalId"),
    ] {
        if let Some(v) = input.get(input_key) {
            invocation[key] = v.clone();
        }
    }
    let Ok(invocation) = contracts::capability(invocation, false) else {
        return rejected();
    };
    let result = settings.capabilities.invoke(&actor, invocation, run).await;
    if result["ok"] == true {
        json_response(result["value"].clone(), 200)
    } else {
        json_response(
            json!({"error":{"code":result["errorCode"],"message":result["errorMessage"]}}),
            if result["errorCode"] == "CAPABILITY_NOT_FOUND" {
                404
            } else {
                400
            },
        )
    }
}
fn missing() -> Response {
    failure(401, "UNAUTHORIZED", "Run token required.").into_response()
}
fn rejected() -> Response {
    failure(403, "FORBIDDEN", "The capability request was rejected.").into_response()
}
