import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { z } from "zod"
import { slaGate } from "./sla-gate"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type { SlaPolicySnapshot } from "@/lib/shared-sla-contract"
import {
  db,
  issueSlas,
  issueStatuses,
  organizations,
  slaPolicies,
  teams,
} from "@/db"
import {
  ApplicationAccessError,
  hasWorkspaceRole,
} from "@/application/authorization"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { executeCommand } from "@/application/commands/execute-command.server"
import { requireFeatureWrite } from "@/application/features/features.server"
import { withoutUndefined } from "@/lib/canonical-json"
import {
  initialSharedSlaPolicy,
  sharedSlaPolicySchema,
  slaPolicyCommandSchema,
  slaReadSchema,
  slaReconciliationSchema,
  slaStatusKey,
} from "@/lib/shared-sla-contract"

function authority(actor: Actor, input: z.infer<typeof slaReadSchema>) {
  requireFeatureWrite(actor, "sla")
  if (
    actor.workspaceId !== input.workspaceId ||
    actor.authentication.kind !== "session" ||
    actor.authentication.sessionId !== input.sessionId ||
    !hasWorkspaceRole(actor, ["owner", "admin"])
  )
    throw new ApplicationAccessError()
}
function reconciliationVersion(
  row: {
    id: string
    gateIdentity: string
    classifiedThrough: string | null
    owedAt: string | null
  },
  workspaceId: string
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.id,
        row.gateIdentity,
        row.classifiedThrough,
        row.owedAt,
        slaGate(workspaceId).identity,
      ])
    )
    .digest("hex")
}
class SlaPolicyValidation extends Error {}
class SlaReconciliationConflict extends Error {}
async function snapshot(
  tx: Transaction,
  actor: Actor
): Promise<SlaPolicySnapshot> {
  const row = (
    await tx
      .select()
      .from(slaPolicies)
      .where(eq(slaPolicies.workspaceId, actor.workspaceId))
  ).at(0)
  const reconciliation = await tx
    .select({
      id: issueSlas.id,
      issueId: issueSlas.issueId,
      deadline: issueSlas.deadlineAt,
      gateIdentity: issueSlas.gateIdentity,
      classifiedThrough: issueSlas.classifiedThrough,
      owedAt: issueSlas.owedAt,
    })
    .from(issueSlas)
    .where(
      and(
        eq(issueSlas.workspaceId, actor.workspaceId),
        eq(issueSlas.gateUncertain, true),
        sql`${issueSlas.owedAt} IS NOT NULL`
      )
    )
    .limit(100)
  const teamDirectory = await tx
    .select({ id: teams.id, name: teams.name, timezone: teams.timezone })
    .from(teams)
    .where(
      and(eq(teams.workspaceId, actor.workspaceId), isNull(teams.deletedAt))
    )
  const statuses = teamDirectory.length
    ? await tx
        .select({
          id: issueStatuses.id,
          teamId: issueStatuses.teamId,
          name: issueStatuses.name,
        })
        .from(issueStatuses)
        .where(
          and(
            eq(issueStatuses.workspaceId, actor.workspaceId),
            inArray(
              issueStatuses.teamId,
              teamDirectory.map((t) => t.id)
            )
          )
        )
    : []
  return {
    revision: row?.revision ?? 0,
    values: row
      ? sharedSlaPolicySchema.parse(row.values)
      : initialSharedSlaPolicy(),
    canManage: true,
    reconciliation: reconciliation.map((row) => ({
      id: row.id,
      issueId: row.issueId,
      deadline: row.deadline,
      version: reconciliationVersion(row, actor.workspaceId),
    })),
    teams: teamDirectory,
    statuses,
  }
}
export async function readSlaPolicy(
  actor: Actor,
  raw: z.input<typeof slaReadSchema>
) {
  const input = slaReadSchema.parse(raw)
  return db.transaction(async (tx) => {
    const current = await currentCommandActor(tx, actor)
    authority(current, input)
    return snapshot(tx, current)
  })
}
class SlaPolicyConflict extends Error {}
export async function saveSlaPolicy(
  actor: Actor,
  raw: z.input<typeof slaPolicyCommandSchema>
) {
  const input = slaPolicyCommandSchema.parse(raw)
  try {
    const result = await executeCommand({
      actor,
      commandKey: input.commandKey,
      operation: "sla.policy@1",
      input: withoutUndefined(input),
      status: 200,
      parse: (value) =>
        z.object({ revision: z.number().int() }).strict().parse(value),
      authorize: async (_tx, current) => authority(current, input),
      run: async (tx, current) => {
        await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, current.workspaceId))
          .for("no key update")
        // Validate tenant-owned references under locks held through commit.
        for (const rule of input.values.rules) {
          if (rule.filters.teamIds) {
            const found = await tx
              .select({ id: teams.id })
              .from(teams)
              .where(
                and(
                  eq(teams.workspaceId, current.workspaceId),
                  inArray(teams.id, rule.filters.teamIds),
                  isNull(teams.deletedAt)
                )
              )
              .for("share")
            if (
              new Set(found.map((t) => t.id)).size !==
              new Set(rule.filters.teamIds).size
            )
              throw new SlaPolicyValidation()
          }
          if (rule.filters.statuses) {
            const found = await tx
              .select({
                statusId: issueStatuses.id,
                teamId: issueStatuses.teamId,
              })
              .from(issueStatuses)
              .where(
                and(
                  eq(issueStatuses.workspaceId, current.workspaceId),
                  or(
                    ...rule.filters.statuses.map((s) =>
                      and(
                        eq(issueStatuses.teamId, s.teamId),
                        eq(issueStatuses.id, s.statusId)
                      )
                    )
                  ),
                  rule.filters.teamIds
                    ? inArray(issueStatuses.teamId, rule.filters.teamIds)
                    : undefined
                )
              )
              .for("share")
            if (
              new Set(found.map(slaStatusKey)).size !==
              new Set(rule.filters.statuses.map(slaStatusKey)).size
            )
              throw new SlaPolicyValidation()
          }
        }
        let row
        if (input.expectedRevision === 0)
          row = (
            await tx
              .insert(slaPolicies)
              .values({
                workspaceId: current.workspaceId,
                values: input.values,
              })
              .onConflictDoNothing()
              .returning()
          )[0]
        else
          row = (
            await tx
              .update(slaPolicies)
              .set({ values: input.values })
              .where(
                and(
                  eq(slaPolicies.workspaceId, current.workspaceId),
                  eq(slaPolicies.revision, input.expectedRevision)
                )
              )
              .returning()
          )[0]
        if (!row) throw new SlaPolicyConflict()
        return {
          value: { revision: row.revision },
          resource: { type: "sla-policy", id: current.workspaceId },
          events: [
            {
              topic: "sla.policy.updated",
              payload: { revision: row.revision, enabled: row.values.enabled },
            },
          ],
        }
      },
    })
    return {
      status: "saved" as const,
      replayed: result.replayed,
      snapshot: await readSlaPolicy(actor, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
      }),
    }
  } catch (error) {
    if (error instanceof SlaPolicyValidation)
      return {
        status: "invalid" as const,
        message:
          "A team or status condition is unavailable. Review the conditions and save again.",
        snapshot: await readSlaPolicy(actor, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
        }),
      }
    if (error instanceof SlaPolicyConflict)
      return {
        status: "conflict" as const,
        snapshot: await readSlaPolicy(actor, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
        }),
      }
    throw error
  }
}
/** Human-reviewed classification of a missing feature-gate interval; never a new deadline. */
export async function reconcileSlaGate(
  actor: Actor,
  raw: z.input<typeof slaReconciliationSchema>
) {
  const input = slaReconciliationSchema.parse(raw)
  return executeCommand({
    actor,
    commandKey: input.commandKey,
    operation: "sla.reconcile@1",
    input,
    status: 200,
    parse: (value) =>
      z.object({ commitmentId: z.uuid() }).strict().parse(value),
    authorize: async (tx, current) => {
      authority(current, input)
      if (
        !(
          await tx
            .select({ id: issueSlas.id })
            .from(issueSlas)
            .where(
              and(
                eq(issueSlas.id, input.commitmentId),
                eq(issueSlas.workspaceId, current.workspaceId)
              )
            )
        )[0]
      )
        throw new ApplicationAccessError()
    },
    run: async (tx, current) => {
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, current.workspaceId))
        .for("no key update")
      const row = (
        await tx
          .select()
          .from(issueSlas)
          .where(eq(issueSlas.id, input.commitmentId))
          .for("update")
      )[0]
      if (!row) throw new ApplicationAccessError()
      if (
        !row.gateUncertain ||
        input.expectedVersion !==
          reconciliationVersion(row, current.workspaceId)
      )
        throw new SlaReconciliationConflict(
          "This interruption changed. Refresh the policy before classifying it."
        )
      await tx
        .update(issueSlas)
        .set({
          gateUncertain: false,
          gateIdentity: slaGate(current.workspaceId).identity,
          classifiedThrough: sql`clock_timestamp()`,
          owedAt:
            input.decision === "breach-owed"
              ? sql`coalesce(${issueSlas.owedAt},clock_timestamp())`
              : null,
        })
        .where(eq(issueSlas.id, row.id))
      await tx.execute(
        sql`SELECT forge_sla_breach(${row.id}::uuid,clock_timestamp())`
      )
      return {
        value: { commitmentId: row.id },
        resource: { type: "sla-commitment", id: row.id },
        events: [
          {
            topic: "sla.gate.reconciled",
            payload: {
              commitmentId: row.id,
              decision: input.decision,
              evidence: input.evidence,
            },
          },
        ],
      }
    },
  })
}
