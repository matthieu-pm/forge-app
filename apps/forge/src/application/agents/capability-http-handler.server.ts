import "@tanstack/react-start/server-only"

import { capabilityInvocationSchema } from "@/application/agents/capability-contract"
import { forgeCapabilityGateway } from "@/adapters/agents/forge-capabilities.server"
import { verifyAgentCapabilityToken } from "@/application/agents/run-token.server"

function bearer(request: Request) {
  const value = request.headers.get("authorization")
  return value?.startsWith("Bearer ")
    ? value.slice("Bearer ".length).trim()
    : null
}

export async function handleCapabilityRequest(
  request: Request,
  capabilityId: string
) {
  if (request.method !== "POST") {
    return Response.json(
      { error: { code: "METHOD_NOT_ALLOWED" } },
      { status: 405 }
    )
  }

  try {
    const token = bearer(request)
    const runId = request.headers.get("x-forge-agent-run-id")
    const workspaceId = request.headers.get("x-forge-workspace-id")
    if (!token || !runId || !workspaceId) {
      return Response.json(
        { error: { code: "UNAUTHORIZED", message: "Run token required." } },
        { status: 401 }
      )
    }
    const actor = await verifyAgentCapabilityToken(token, {
      runId,
      workspaceId,
      capabilityId,
    })
    const body = (await request.json()) as {
      version?: unknown
      input?: unknown
      idempotencyKey?: unknown
      approvalId?: unknown
    }
    const invocation = capabilityInvocationSchema.parse({
      capabilityId,
      capabilityVersion: body.version,
      input: body.input,
      idempotencyKey: body.idempotencyKey,
      approvalId: body.approvalId,
    })
    const result = await forgeCapabilityGateway.invoke(actor, invocation, {
      runId,
      abortSignal: request.signal,
    })
    if (!result.ok) {
      return Response.json(
        {
          error: {
            code: result.errorCode,
            message: result.errorMessage,
          },
        },
        { status: result.errorCode === "CAPABILITY_NOT_FOUND" ? 404 : 400 }
      )
    }
    return Response.json(result.value, {
      headers: { "cache-control": "no-store" },
    })
  } catch {
    return Response.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "The capability request was rejected.",
        },
      },
      { status: 403 }
    )
  }
}
