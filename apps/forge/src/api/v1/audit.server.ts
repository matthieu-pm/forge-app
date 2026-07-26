import "@tanstack/react-start/server-only"

import type { Actor } from "@/application/actor"

export function writeApiAuditEvent({
  actor,
  operation,
  outcome,
  requestId,
  resourceId,
}: {
  actor: Actor
  operation: string
  outcome: "succeeded" | "replayed" | "rejected"
  requestId: string
  resourceId?: string
}) {
  const credentialId =
    actor.authentication.kind === "apiKey"
      ? actor.authentication.credentialId
      : actor.authentication.kind === "session"
        ? actor.authentication.sessionId
        : actor.authentication.tokenId

  console.info(
    JSON.stringify({
      event: "forge.public_api.mutation",
      timestamp: new Date().toISOString(),
      requestId,
      operation,
      outcome,
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      authenticationKind: actor.authentication.kind,
      credentialId,
      resourceId,
    })
  )
}
