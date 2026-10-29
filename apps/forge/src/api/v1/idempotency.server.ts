import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { and, eq } from "drizzle-orm"
import type { CommandOptions } from "@/application/commands/execute-command.server"
import { apiIdempotencyKeys } from "@/db"
import {
  CommandConflictError,
  executeCommand,
} from "@/application/commands/execute-command.server"

export { CommandConflictError as IdempotencyConflictError }

/** Public API adapter; legacy leases are evidence, never permission to repeat. */
export async function executeIdempotent<T>({
  actor,
  idempotencyKey,
  operationId,
  input,
  ...options
}: Omit<CommandOptions<T>, "commandKey" | "operation" | "legacy"> & {
  idempotencyKey: string
  operationId: string
}) {
  if (actor.authentication.kind !== "apiKey")
    throw new Error("Idempotent API operations require an API-key actor.")
  const credentialId = actor.authentication.credentialId
  return executeCommand({
    ...options,
    actor,
    input,
    commandKey: idempotencyKey,
    operation: operationId,
    legacy: async (tx) => {
      const existing = (
        await tx
          .select()
          .from(apiIdempotencyKeys)
          .where(
            and(
              eq(apiIdempotencyKeys.workspaceId, actor.workspaceId),
              eq(apiIdempotencyKeys.credentialId, credentialId),
              eq(apiIdempotencyKeys.operationId, operationId),
              eq(apiIdempotencyKeys.idempotencyKey, idempotencyKey)
            )
          )
          .for("share")
      ).at(0)
      if (!existing) return null
      // Preserve the original hash protocol for receipts written by the old wrapper.
      const hash = createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex")
      if (existing.requestHash !== hash)
        throw new CommandConflictError(
          "reused",
          "The idempotency key was already used with a different request."
        )
      if (existing.responseBody === null || existing.responseStatus === null)
        throw new CommandConflictError(
          "ambiguous",
          "The legacy command outcome requires reconciliation before retry."
        )
      return { value: options.parse(JSON.parse(existing.responseBody)) }
    },
  })
}
