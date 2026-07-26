import "@tanstack/react-start/server-only"

import { SignJWT, jwtVerify } from "jose"
import { z } from "zod"

import type { Actor } from "@/application/actor"

const claimsSchema = z.object({
  sub: z.string().min(1),
  workspaceId: z.string().min(1),
  runId: z.string().uuid(),
  threadId: z.string().uuid(),
  tokenId: z.string().uuid(),
})

function secret() {
  const value = process.env.FORGE_AGENT_LOCAL_INGEST_SECRET
  if (!value || value.length < 32) {
    throw new Error(
      "FORGE_AGENT_LOCAL_INGEST_SECRET must contain at least 32 characters."
    )
  }
  return Buffer.from(value, "utf8")
}

export async function mintLocalIngestToken(input: {
  actor: Actor
  runId: string
  threadId: string
  expiresInSeconds?: number
}) {
  const tokenId = crypto.randomUUID()
  return new SignJWT({
    workspaceId: input.actor.workspaceId,
    runId: input.runId,
    threadId: input.threadId,
    tokenId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(input.actor.userId)
    .setIssuer("forge")
    .setAudience("forge-local-ingest")
    .setJti(tokenId)
    .setIssuedAt()
    .setExpirationTime(`${Math.max(30, input.expiresInSeconds ?? 15 * 60)}s`)
    .sign(secret())
}

export async function verifyLocalIngestToken(
  token: string,
  expected: {
    actor: Actor
    runId: string
    threadId?: string
  }
) {
  const result = await jwtVerify(token, secret(), {
    issuer: "forge",
    audience: "forge-local-ingest",
    algorithms: ["HS256"],
  })
  const claims = claimsSchema.parse(result.payload)
  if (
    claims.sub !== expected.actor.userId ||
    claims.workspaceId !== expected.actor.workspaceId ||
    claims.runId !== expected.runId ||
    (expected.threadId && claims.threadId !== expected.threadId)
  ) {
    throw new Error("The local ingest token is outside its allowed scope.")
  }
  return claims
}
