import "@tanstack/react-start/server-only"
import { parseTeamCycles } from "@/lib/team-cycles-contract"
import { parseTeamTriage } from "@/lib/team-triage-contract"
import { and, eq, or } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type {
  ProductStateCommand,
  ProductStateSnapshot,
} from "@/lib/product-state-contract"
import { db, productState, teamMembers, teams } from "@/db"
import {
  ApplicationAccessError,
  hasWorkspaceRole,
} from "@/application/authorization"
import { readableTeamCondition } from "@/application/resource-policy.server"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { executeCommand } from "@/application/commands/execute-command.server"
import {
  isProductStorageKey,
  productStateCommandSchema,
} from "@/lib/product-state-contract"
import { z } from "zod"

function session(
  actor: Actor,
  workspaceId = actor.workspaceId,
  sessionId?: string
) {
  if (
    actor.workspaceId !== workspaceId ||
    actor.authentication.kind !== "session" ||
    (sessionId && actor.authentication.sessionId !== sessionId)
  )
    throw new ApplicationAccessError()
}
async function scope(
  tx: Transaction,
  actor: Actor,
  key: string,
  write = false
) {
  if (!isProductStorageKey(key)) throw new ApplicationAccessError()
  const workspace = key.match(/^forge:workspace:([^:]+):/)?.[1]
  if (workspace && workspace !== actor.workspaceId)
    throw new ApplicationAccessError()
  const team =
    key.match(
      /^forge:(?:team-[^:]+|cycle-issues|triage-issues|triage-draft):v1:([0-9a-f-]{36})(?::[0-9a-f-]{36})?$/
    )?.[1] ?? key.match(/^forge:team-issue-labels:([0-9a-f-]{36}):v1$/)?.[1]
  if (team) {
    const row = (
      await tx
        .select()
        .from(teams)
        .where(and(eq(teams.id, team), readableTeamCondition(actor, teams.id)))
        .for("share")
    )[0]
    if (!row) throw new ApplicationAccessError()
    if (
      row.visibility === "private" &&
      !hasWorkspaceRole(actor, ["owner", "admin"])
    ) {
      if (
        !(
          await tx
            .select({ id: teamMembers.id })
            .from(teamMembers)
            .where(
              and(
                eq(teamMembers.workspaceId, actor.workspaceId),
                eq(teamMembers.teamId, team),
                eq(teamMembers.userId, actor.userId)
              )
            )
            .for("share")
        )[0]
      )
        throw new ApplicationAccessError()
    }
  }
  const shared =
    /^forge:team-(?:cycles|triage|project-updates|thread-summaries):v1:/.test(
      key
    )
  if (write && shared && !hasWorkspaceRole(actor, ["owner", "admin"])) {
    // Project/initiative content is contributor work; configuration is administrative.
    if (!key.endsWith(":initiatives:v1"))
      throw new ApplicationAccessError(
        "Only workspace admins can change shared team settings."
      )
  }
  return shared ? "workspace" : `user:${actor.userId}`
}
export async function readProductState(
  actor: Actor
): Promise<ProductStateSnapshot> {
  session(actor)
  return db.transaction(async (tx) => {
    const current = await currentCommandActor(tx, actor)
    const rows = await tx
      .select()
      .from(productState)
      .where(
        and(
          eq(productState.workspaceId, current.workspaceId),
          or(
            eq(productState.ownerId, `user:${current.userId}`),
            eq(productState.ownerId, "workspace")
          )
        )
      )
    const entries: ProductStateSnapshot["entries"] = []
    for (const row of rows) {
      try {
        if ((await scope(tx, current, row.key)) === row.ownerId)
          entries.push({
            key: row.key,
            value: row.encodedValue===null?null:JSON.parse(row.encodedValue) as string,
            revision: row.revision,
          })
      } catch {
        /* Revoked/private resources are omitted. */
      }
    }
    return {
      workspaceId: current.workspaceId,
      userId: current.userId,
      sessionId:
        actor.authentication.kind === "session"
          ? actor.authentication.sessionId
          : "",
      entries,
      teamIds:(await tx.select({id:teams.id}).from(teams).where(readableTeamCondition(current,teams.id))).map(t=>t.id),
    }
  })
}
export async function saveProductState(actor: Actor, raw: ProductStateCommand) {
  const input = productStateCommandSchema.parse(raw)
  session(actor, input.workspaceId, input.sessionId)
  if (input.value !== null) {
    if (input.key.startsWith("forge:team-cycles:v1:"))
      parseTeamCycles(input.value)
    if (input.key.startsWith("forge:team-triage:v1:"))
      parseTeamTriage(input.value)
    if (input.key.startsWith("forge:team-project-updates:v1:"))
      z.object({ guidance: z.string().max(50000) }).parse(
        JSON.parse(input.value)
      )
    if (input.key.startsWith("forge:team-thread-summaries:v1:"))
      z.enum(["true", "false"]).parse(input.value)
  }
  const { commandKey, sessionId: _sessionId, ...commandInput } = input
  return executeCommand({
    actor,
    commandKey,
    operation: "productState.save@1",
    input: commandInput,
    status: 200,
    parse: (value) =>
      z.object({ revision: z.number().int() }).strict().parse(value),
    authorize: async (tx, current) => {
      session(current)
      await scope(tx, current, input.key, true)
    },
    run: async (tx, current) => {
      const ownerId = await scope(tx, current, input.key, true)
      await tx
        .insert(productState)
        .values({
          workspaceId: current.workspaceId,
          ownerId,
          ownerUserId: ownerId === "workspace" ? null : current.userId,
          teamId:
            input.key.match(
              /^forge:(?:team-[^:]+|cycle-issues|triage-issues|triage-draft):v1:([0-9a-f-]{36})(?::[0-9a-f-]{36})?$/
            )?.[1] ??
            input.key.match(
              /^forge:team-issue-labels:([0-9a-f-]{36}):v1$/
            )?.[1] ??
            null,
          key: input.key,
          encodedValue: null,
        })
        .onConflictDoNothing()
      const predicate = and(
        eq(productState.workspaceId, current.workspaceId),
        eq(productState.ownerId, ownerId),
        eq(productState.key, input.key)
      )
      const row = (
        await tx.select().from(productState).where(predicate).for("update")
      )[0]
      if (row.revision !== input.expectedRevision) {
        if ((row.encodedValue===null?null:JSON.parse(row.encodedValue)) === input.value)
          return {
            value: { revision: row.revision },
            resource: { type: "productState", id: row.id },
            events: [],
          }
        throw new Error(
          "This data changed in another session. Your pending changes are preserved in this session; reload the latest version before retrying."
        )
      }
      await tx
        .update(productState)
        .set({ encodedValue: input.value===null?null:JSON.stringify(input.value), revision: row.revision + 1 })
        .where(predicate)
      return {
        value: { revision: row.revision + 1 },
        resource: { type: "productState", id: row.id },
        events: [],
      }
    },
  })
}
