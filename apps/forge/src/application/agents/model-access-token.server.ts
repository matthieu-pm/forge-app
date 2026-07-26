import "@tanstack/react-start/server-only"

import { SignJWT, jwtVerify } from "jose"
import { z } from "zod"

import type { Actor } from "@/application/actor"

const claimsSchema = z.object({
  sub: z.string().min(1),
  workspaceId: z.string().min(1),
  runId: z.string().uuid(),
  connectionId: z.string().uuid(),
  provider: z.string().min(1).max(100),
  modelId: z.string().min(1).max(255),
  tokenId: z.string().uuid(),
})

function secret() {
  const value = process.env.FORGE_AGENT_MODEL_ACCESS_SECRET
  if (!value || value.length < 32) {
    throw new Error(
      "FORGE_AGENT_MODEL_ACCESS_SECRET must contain at least 32 characters."
    )
  }
  return new TextEncoder().encode(value)
}

export async function mintAgentModelAccessToken(input: {
  actor: Actor
  runId: string
  connectionId: string
  provider: string
  modelId: string
  expiresInSeconds?: number
}) {
  const tokenId = crypto.randomUUID()
  return new SignJWT({
    workspaceId: input.actor.workspaceId,
    runId: input.runId,
    connectionId: input.connectionId,
    provider: input.provider,
    modelId: input.modelId,
    tokenId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(input.actor.userId)
    .setIssuer("forge")
    .setAudience("forge-model-access")
    .setJti(tokenId)
    .setIssuedAt()
    .setExpirationTime(`${Math.max(30, input.expiresInSeconds ?? 15 * 60)}s`)
    .sign(secret())
}

export async function verifyAgentModelAccessToken(token: string) {
  const result = await jwtVerify(token, secret(), {
    issuer: "forge",
    audience: "forge-model-access",
    algorithms: ["HS256"],
  })
  return claimsSchema.parse(result.payload)
}
