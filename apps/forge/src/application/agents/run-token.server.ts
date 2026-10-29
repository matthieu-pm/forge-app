import "@tanstack/react-start/server-only"

import { SignJWT, jwtVerify } from "jose"
import { z } from "zod"

import type { Actor, ApiScope } from "@/application/actor"

const capabilityClaimsSchema = z.object({
  sub: z.string().min(1),
  workspaceId: z.string().min(1),
  workspaceRole: z.string().min(1),
  runId: z.string().uuid(),
  tokenId: z.string().uuid(),
  scopes: z.array(z.string()),
  capabilities: z.array(z.string()),
})

function secret() {
  const value = process.env.FORGE_AGENT_CAPABILITY_SECRET
  if (!value || value.length < 32) {
    throw new Error(
      "FORGE_AGENT_CAPABILITY_SECRET must contain at least 32 characters."
    )
  }
  return new TextEncoder().encode(value)
}

export async function mintAgentCapabilityToken({
  actor,
  runId,
  capabilities,
  expiresInSeconds = 300,
}: {
  actor: Actor
  runId: string
  capabilities: ReadonlyArray<string>
  expiresInSeconds?: number
}) {
  const tokenId = crypto.randomUUID()
  const scopes = new Set<ApiScope>()
  if (capabilities.some((capability) => capability.startsWith("teams."))) {
    scopes.add("teams:read")
  }
  if (capabilities.includes("workspace.describe")) {
    scopes.add("teams:read")
  }
  if (capabilities.includes("teams.update")) {
    scopes.add("teams:write")
  }
  if (capabilities.includes("artifacts.create")) scopes.add("agents:write")
  return new SignJWT({
    workspaceId: actor.workspaceId,
    workspaceRole: actor.workspaceRole,
    runId,
    tokenId,
    scopes: [...scopes],
    capabilities,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(actor.userId)
    .setIssuer("forge")
    .setAudience("forge-capability")
    .setJti(tokenId)
    .setIssuedAt()
    .setExpirationTime(`${Math.max(30, expiresInSeconds)}s`)
    .sign(secret())
}

export async function verifyAgentCapabilityToken(
  token: string,
  expected: {
    runId: string
    workspaceId: string
    capabilityId: string
  }
): Promise<Actor> {
  const verification = await jwtVerify(token, secret(), {
    issuer: "forge",
    audience: "forge-capability",
    algorithms: ["HS256"],
  })
  const claims = capabilityClaimsSchema.parse(verification.payload)
  if (
    claims.runId !== expected.runId ||
    claims.workspaceId !== expected.workspaceId ||
    !claims.capabilities.includes(expected.capabilityId)
  ) {
    throw new Error("The agent capability token is outside its allowed scope.")
  }

  return {
    userId: claims.sub,
    workspaceId: claims.workspaceId,
    workspaceRole: claims.workspaceRole,
    authentication: {
      kind: "agent",
      runId: claims.runId,
      tokenId: claims.tokenId,
    },
    scopes: claims.scopes as Array<ApiScope>,
  }
}
