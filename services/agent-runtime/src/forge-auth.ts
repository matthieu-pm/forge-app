import { emitTelemetry } from "../../../packages/telemetry/server.js"
import { jwtVerify } from "jose"
import { z } from "zod"

const claimsSchema = z.object({
  sub: z.string().min(1),
  correlationId: z.string().uuid().optional(),
  workspaceId: z.string().min(1),
  runId: z.string().uuid(),
  forgeCapabilityToken: z.string().min(20),
  forgeModelAccessToken: z.string().min(20),
  provider: z.string().min(1).max(100),
  modelId: z.string().min(1).max(255),
  reasoningEffort: z.enum([
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]),
})

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization")
  if (!authorization?.startsWith("Bearer ")) return null
  return authorization.slice("Bearer ".length).trim()
}

export async function verifyForgeChannelRequest(request: Request) {
  const token = bearerToken(request)
  const secret = process.env.FORGE_AGENT_CHANNEL_SECRET
  if (!token || !secret) return null

  try {
    const verification = await jwtVerify(
      token,
      new TextEncoder().encode(secret),
      {
        issuer: "forge",
        audience: "forge-agent-runtime",
        algorithms: ["HS256"],
      }
    )
    const claims = claimsSchema.parse(verification.payload)

    emitTelemetry("run.linked", "runtime.authenticate", {
      runId: claims.runId,
      correlationId: claims.correlationId ?? claims.runId,
    })
    return {
      authenticator: "forge",
      principalId: claims.sub,
      principalType: "user" as const,
      attributes: {
        workspaceId: claims.workspaceId,
        runId: claims.runId,
        correlationId: claims.correlationId ?? claims.runId,
        forgeCapabilityToken: claims.forgeCapabilityToken,
        forgeModelAccessToken: claims.forgeModelAccessToken,
        provider: claims.provider,
        modelId: claims.modelId,
        reasoningEffort: claims.reasoningEffort,
      },
    }
  } catch {
    emitTelemetry("operation.failed", "runtime.authenticate", {
      errorCode: "UNAUTHORIZED",
    })
    return null
  }
}
