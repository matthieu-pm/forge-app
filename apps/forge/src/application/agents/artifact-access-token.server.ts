import "@tanstack/react-start/server-only"

import { SignJWT, jwtVerify } from "jose"
import { z } from "zod"

import type { Actor } from "@/application/actor"

const claimsSchema = z.object({
  sub: z.string().min(1),
  workspaceId: z.string().min(1),
  artifactId: z.string().uuid(),
})

export class ArtifactAccessTokenError extends Error {
  constructor(message = "The artifact download link is invalid or expired.") {
    super(message)
    this.name = "ArtifactAccessTokenError"
  }
}

function secret() {
  const value =
    process.env.FORGE_AGENT_ARTIFACT_SECRET ??
    process.env.FORGE_AGENT_CAPABILITY_SECRET
  if (!value || value.length < 32) {
    throw new Error(
      "FORGE_AGENT_ARTIFACT_SECRET must contain at least 32 characters."
    )
  }
  return new TextEncoder().encode(value)
}

export async function mintArtifactAccessToken(
  actor: Actor,
  artifactId: string,
  expiresInSeconds = 300
) {
  return new SignJWT({
    workspaceId: actor.workspaceId,
    artifactId,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(actor.userId)
    .setIssuer("forge")
    .setAudience("forge-agent-artifact")
    .setIssuedAt()
    .setExpirationTime(`${Math.max(30, expiresInSeconds)}s`)
    .sign(secret())
}

export async function verifyArtifactAccessToken(
  token: string,
  actor: Actor,
  artifactId: string
) {
  const signingKey = secret()
  try {
    const verified = await jwtVerify(token, signingKey, {
      issuer: "forge",
      audience: "forge-agent-artifact",
      algorithms: ["HS256"],
    })
    const claims = claimsSchema.parse(verified.payload)
    if (
      claims.sub !== actor.userId ||
      claims.workspaceId !== actor.workspaceId ||
      claims.artifactId !== artifactId
    ) {
      throw new ArtifactAccessTokenError()
    }
  } catch (error) {
    if (error instanceof ArtifactAccessTokenError) throw error
    throw new ArtifactAccessTokenError()
  }
}
