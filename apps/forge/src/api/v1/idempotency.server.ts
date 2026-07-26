import "@tanstack/react-start/server-only"

import { and, eq, lt } from "drizzle-orm"

import type { Actor } from "@/application/actor"
import { apiIdempotencyKeys, db } from "@/db"

export class IdempotencyConflictError extends Error {
  constructor(
    readonly reason: "reused" | "in-progress",
    message: string
  ) {
    super(message)
    this.name = "IdempotencyConflictError"
  }
}

async function requestHash(value: unknown) {
  const input = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest("SHA-256", input)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

export async function executeIdempotent<T>({
  actor,
  idempotencyKey,
  input,
  operationId,
  parse,
  run,
  status,
}: {
  actor: Actor
  idempotencyKey: string
  input: unknown
  operationId: string
  parse: (value: unknown) => T
  run: () => Promise<T>
  status: number
}): Promise<{ replayed: boolean; value: T }> {
  if (actor.authentication.kind !== "apiKey") {
    throw new Error("Idempotent API operations require an API-key actor.")
  }

  const credentialId = actor.authentication.credentialId
  const hash = await requestHash(input)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000)

  await db
    .delete(apiIdempotencyKeys)
    .where(
      and(
        eq(apiIdempotencyKeys.credentialId, credentialId),
        lt(apiIdempotencyKeys.expiresAt, now)
      )
    )

  const reservations = await db
    .insert(apiIdempotencyKeys)
    .values({
      workspaceId: actor.workspaceId,
      credentialId,
      operationId,
      idempotencyKey,
      requestHash: hash,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: apiIdempotencyKeys.id })
  const reservation = reservations.at(0)

  if (!reservation) {
    const existingRows = await db
      .select()
      .from(apiIdempotencyKeys)
      .where(
        and(
          eq(apiIdempotencyKeys.credentialId, credentialId),
          eq(apiIdempotencyKeys.operationId, operationId),
          eq(apiIdempotencyKeys.idempotencyKey, idempotencyKey)
        )
      )
      .limit(1)
    const existing = existingRows.at(0)

    if (!existing || existing.requestHash !== hash) {
      throw new IdempotencyConflictError(
        "reused",
        "The idempotency key was already used with a different request."
      )
    }

    if (!existing.responseBody) {
      throw new IdempotencyConflictError(
        "in-progress",
        "A request with this idempotency key is still in progress."
      )
    }

    return {
      replayed: true,
      value: parse(JSON.parse(existing.responseBody) as unknown),
    }
  }

  let value: T
  try {
    value = await run()
  } catch (error) {
    await db
      .delete(apiIdempotencyKeys)
      .where(eq(apiIdempotencyKeys.id, reservation.id))
    throw error
  }

  await db
    .update(apiIdempotencyKeys)
    .set({ responseStatus: status, responseBody: JSON.stringify(value) })
    .where(eq(apiIdempotencyKeys.id, reservation.id))

  return { replayed: false, value }
}
