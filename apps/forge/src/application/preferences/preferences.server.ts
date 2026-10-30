import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import type { Actor } from "@/application/actor"
import type {
  AccountPreferenceCommand,
  PreferenceSaveResult,
  PreferenceSnapshot,
} from "@/lib/account-preference-contract"
import { workspacePreferenceField } from "@/lib/workspace-preference-contract"
import { accountPreferences, db, workspacePreferences } from "@/db"
import {
  ACCOUNT_PREFERENCE_VERSION,
  accountPreferenceCommandSchema,
  accountPreferenceFields,
  emptyPreferenceSnapshot,
  preferenceSnapshotSchema,
} from "@/lib/account-preference-contract"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { executeCommand } from "@/application/commands/execute-command.server"
import { ApplicationAccessError } from "@/application/authorization"

export function assertPreferenceSession(actor: Actor, sessionId?: string) {
  if (
    actor.authentication.kind !== "session" ||
    (sessionId !== undefined && actor.authentication.sessionId !== sessionId)
  )
    throw new ApplicationAccessError()
}
export function assertPreferenceSyncEnabled() {
  if (process.env.FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED !== "true")
    throw new Error("Personal preference synchronization is unavailable.")
}
class PreferenceConflict extends Error {
  constructor(readonly fields: Array<string>) {
    super("These preferences changed in another session.")
  }
}
function snapshot(
  userId: string,
  row?:
    | typeof accountPreferences.$inferSelect
    | typeof workspacePreferences.$inferSelect
): PreferenceSnapshot {
  return row
    ? preferenceSnapshotSchema.parse({ ...row, userId })
    : emptyPreferenceSnapshot(userId)
}
export async function readAccountPreferences(
  actor: Actor,
  scope: "account" | "workspace" = "account"
): Promise<PreferenceSnapshot> {
  assertPreferenceSyncEnabled()
  assertPreferenceSession(actor)
  return db.transaction(async (tx) => {
    await currentCommandActor(tx, actor)
    const row =
      scope === "workspace"
        ? (
            await tx
              .select()
              .from(workspacePreferences)
              .where(
                and(
                  eq(workspacePreferences.userId, actor.userId),
                  eq(workspacePreferences.workspaceId, actor.workspaceId)
                )
              )
          ).at(0)
        : (
            await tx
              .select()
              .from(accountPreferences)
              .where(eq(accountPreferences.userId, actor.userId))
          ).at(0)
    const result = snapshot(actor.userId, row)
    return scope === "workspace"
      ? { ...result, workspaceId: actor.workspaceId }
      : result
  })
}
export async function patchAccountPreferences(
  actor: Actor,
  raw: AccountPreferenceCommand
): Promise<PreferenceSaveResult> {
  assertPreferenceSyncEnabled()
  const input = accountPreferenceCommandSchema.parse(raw)
  assertPreferenceSession(actor, input.sessionId)
  const scope = input.scope ?? "account"
  // Session binding prevents a queued request being sent under a different login.
  // It is not part of the durable identity, allowing a proven retry after refresh.
  const { sessionId: _sessionId, commandKey, ...commandInput } = input
  try {
    await executeCommand({
      actor,
      commandKey,
      operation: `${scope}Preferences.patch@1`,
      input: commandInput,
      status: 200,
      parse: (value) =>
        z
          .object({ userId: z.string(), revision: z.number().int() })
          .strict()
          .parse(value),
      authorize: async (_tx, current, result) => {
        assertPreferenceSession(current)
        if (result && result.userId !== current.userId)
          throw new ApplicationAccessError()
      },
      run: async (tx, current) => {
        let row:
          | typeof accountPreferences.$inferSelect
          | typeof workspacePreferences.$inferSelect
        if (scope === "workspace") {
          await tx
            .insert(workspacePreferences)
            .values({
              userId: current.userId,
              workspaceId: current.workspaceId,
            })
            .onConflictDoNothing()
          row = (
            await tx
              .select()
              .from(workspacePreferences)
              .where(
                and(
                  eq(workspacePreferences.userId, current.userId),
                  eq(workspacePreferences.workspaceId, current.workspaceId)
                )
              )
              .for("update")
          )[0]
        } else {
          await tx
            .insert(accountPreferences)
            .values({ userId: current.userId })
            .onConflictDoNothing()
          row = (
            await tx
              .select()
              .from(accountPreferences)
              .where(eq(accountPreferences.userId, current.userId))
              .for("update")
          )[0]
        }
        if (row.version !== ACCOUNT_PREFERENCE_VERSION)
          throw new Error("Preferences require a newer version of Forge.")
        const fields = Object.keys(input.patch)
        const conflicting = fields.filter(
          (key) => (row.fieldVersions[key] ?? 0) !== input.expectedVersions[key]
        )
        if (conflicting.length) throw new PreferenceConflict(conflicting)
        const revision = row.revision + 1
        const values = { ...row.values },
          fieldVersions = { ...row.fieldVersions }
        for (const key of fields) {
          values[key] = (
            scope === "workspace"
              ? workspacePreferenceField(key)!
              : accountPreferenceFields[key]
          ).parse(input.patch[key])
          fieldVersions[key] = revision
        }
        if (scope === "workspace")
          await tx
            .update(workspacePreferences)
            .set({ values, fieldVersions, revision })
            .where(
              and(
                eq(workspacePreferences.userId, current.userId),
                eq(workspacePreferences.workspaceId, current.workspaceId)
              )
            )
        else
          await tx
            .update(accountPreferences)
            .set({ values, fieldVersions, revision })
            .where(eq(accountPreferences.userId, current.userId))
        // Only identity/revision in the receipt; no private values in shared audit or outbox.
        return {
          value: { userId: current.userId, revision },
          resource: { type: `${scope}Preferences`, id: current.userId },
          events: [],
        }
      },
    })
    return {
      status: "saved",
      snapshot: await readAccountPreferences(actor, scope),
    }
  } catch (error) {
    if (error instanceof PreferenceConflict)
      return {
        status: "conflict",
        fields: error.fields,
        snapshot: await readAccountPreferences(actor, scope),
      }
    throw error
  }
}
