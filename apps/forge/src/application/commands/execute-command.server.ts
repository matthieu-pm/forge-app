import "@tanstack/react-start/server-only"
import { and, eq, sql } from "drizzle-orm"
import { canonicalCommandInput, commandInputHash } from "./command-input"
import { commandPrincipal, currentCommandActor } from "./command-actor.server"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import {
  commandAuditEvents,
  commandOutboxEvents,
  commandReceipts,
  db,
  users,
} from "@/db"
import { issueHistoryDetailsSchema } from "@/lib/issue-history-contract"

export class CommandConflictError extends Error {
  constructor(
    readonly reason: "reused" | "ambiguous" | "result-unavailable",
    message: string
  ) {
    super(message)
    this.name = "CommandConflictError"
  }
}

export type CommandResult<T> = {
  value: T
  resource: { type: string; id: string }
  events: Array<{ topic: string; payload: Record<string, unknown> }>
}
export type CommandOptions<T> = {
  actor: Actor
  commandKey: string
  operation: string
  input: unknown
  status: number
  parse: (value: unknown) => T
  /** Called before looking up any receipt and again with the saved resource on replay. */
  authorize: (tx: Transaction, actor: Actor, value?: T) => Promise<void>
  run: (tx: Transaction, actor: Actor) => Promise<CommandResult<T>>
  /** Compatibility lookup, inside the same transaction and after live authorization. */
  legacy?: (tx: Transaction, actor: Actor) => Promise<{ value: T } | null>
}

/** SQL-only callback. Never deliver mail, call providers or invalidate caches here. */
export async function executeCommand<T>(
  options: CommandOptions<T>
): Promise<{ replayed: boolean; value: T }> {
  const { actor, commandKey, operation, input, status, parse, authorize, run } =
    options
  if (
    !commandKey ||
    commandKey.length > 255 ||
    !operation ||
    !Number.isInteger(status) ||
    status < 200 ||
    status > 299
  )
    throw new TypeError("Invalid command identity or success status.")
  const inputHash = commandInputHash(input)
  return db.transaction(async (tx) => {
    const currentActor = await currentCommandActor(tx, actor)
    await authorize(tx, currentActor)
    const scope = and(
      eq(commandReceipts.workspaceId, actor.workspaceId),
      eq(commandReceipts.principal, commandPrincipal(actor)),
      eq(commandReceipts.operation, operation),
      eq(commandReceipts.commandKey, commandKey)
    )
    // The unique index serializes independent processes. A rollback releases the
    // reservation; a committed owner makes the waiter read its durable receipt.
    const reserved = (
      await tx
        .insert(commandReceipts)
        .values({
          workspaceId: actor.workspaceId,
          userId: actor.userId,
          principal: commandPrincipal(actor),
          operation,
          commandKey,
          inputHash,
        })
        .onConflictDoNothing()
        .returning()
    ).at(0)
    if (!reserved) {
      const existing = (
        await tx.select().from(commandReceipts).where(scope).for("share")
      ).at(0)
      if (
        !existing ||
        existing.inputHash !== inputHash ||
        existing.userId !== actor.userId
      )
        throw new CommandConflictError(
          "reused",
          "The command key was already used with different input."
        )
      if (!existing.completedAt)
        throw new CommandConflictError(
          "ambiguous",
          "The command outcome requires reconciliation before retry."
        )
      if (existing.responseBody === null)
        throw new CommandConflictError(
          "result-unavailable",
          "The command result is no longer available; its effect cannot be repeated."
        )
      const value = parse(JSON.parse(existing.responseBody))
      await authorize(tx, currentActor, value)
      return { replayed: true, value }
    }
    const legacy = await options.legacy?.(tx, currentActor)
    if (legacy) {
      // Do not invent history/outbox for a legacy effect that cannot be proven.
      await tx
        .delete(commandReceipts)
        .where(eq(commandReceipts.id, reserved.id))
      await authorize(tx, currentActor, legacy.value)
      return { replayed: true, value: legacy.value }
    }
    const result = await run(tx, currentActor)
    const value = parse(result.value)
    const responseBody = canonicalCommandInput(value)
    if (!result.resource.id || !result.resource.type)
      throw new TypeError(
        "Commands must return a JSON result and resource identity."
      )
    await authorize(tx, currentActor, value)
    await tx.insert(commandAuditEvents).values({
      workspaceId: actor.workspaceId,
      commandId: reserved.id,
      actorUserId: actor.userId,
      operation,
      resourceType: result.resource.type,
      resourceId: result.resource.id,
    })
    if (result.events.length) {
      const actorName =
        (
          await tx
            .select({ name: users.name })
            .from(users)
            .where(eq(users.id, currentActor.userId))
        )[0]?.name.slice(0, 200) ?? "Member"
      await tx.insert(commandOutboxEvents).values(
        result.events.map((event, ordinal) => ({
          workspaceId: actor.workspaceId,
          commandId: reserved.id,
          ordinal,
          topic: event.topic,
          // Only the authenticated command boundary writes attributable metadata.
          // Do not retain credential/session secrets or duplicate comment bodies.
          payload: {
            ...event.payload,
            ...(event.topic.startsWith("issue.")
              ? {
                  history: {
                    ...issueHistoryDetailsSchema.parse(
                      event.payload.history ?? { version: 1 }
                    ),
                    actor: {
                      userId: currentActor.userId,
                      name: actorName,
                      kind: currentActor.authentication.kind,
                    },
                  },
                }
              : {}),
          },
          createdAt: sql`clock_timestamp()`,
        }))
      )
    }
    await tx
      .update(commandReceipts)
      .set({
        responseBody,
        responseStatus: status,
        resourceType: result.resource.type,
        resourceId: result.resource.id,
        completedAt: new Date(),
      })
      .where(eq(commandReceipts.id, reserved.id))
    return { replayed: false, value }
  })
}
