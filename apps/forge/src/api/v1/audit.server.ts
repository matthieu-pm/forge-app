import "@tanstack/react-start/server-only"

import type { Actor } from "@/application/actor"
import { emitTelemetry } from "@/application/observability/telemetry.server"

export function writeApiAuditEvent({
  operation,
  outcome,
  requestId,
}: {
  actor: Actor
  operation: "createTeam" | "updateTeam" | "archiveTeam"
  outcome: "succeeded" | "replayed" | "rejected"
  requestId: string
  resourceId?: string
}) {
  // Authentication identifiers and resource/user content do not belong in diagnostics.
  emitTelemetry(
    "api.mutation",
    operation === "createTeam"
      ? "teams.create"
      : operation === "updateTeam"
        ? "teams.update"
        : "teams.archive",
    { requestId, outcome }
  )
}
