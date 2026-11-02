import "@tanstack/react-start/server-only"
import { createHash, createHmac } from "node:crypto"
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm"
import { z } from "zod"
import { loopPrincipalId } from "./loop-actor.server"
import {
  LoopPolicyError,
  loopTeamAccess,
  loopsEnabled,
} from "./loop-access.server"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type {
  LoopCommandResult,
  LoopSnapshot,
  SharedLoop,
} from "@/lib/loop-contract"
import {
  agentApprovals,
  db,
  loopRevisions,
  loopRuns,
  teamLoops,
  users,
} from "@/db"
import { ApplicationAccessError } from "@/application/authorization"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { executeCommand } from "@/application/commands/execute-command.server"
import { withoutUndefined } from "@/lib/canonical-json"
import { commandInputHash } from "@/application/commands/command-input"
import { loopCommandSchema, loopFieldsSchema } from "@/lib/loop-contract"
import { nextLoopScheduledAt } from "@/lib/loop-matching"

export const webhookHash = (secret: string) =>
  createHash("sha256").update(secret).digest("hex")
function webhookSecret(loopId: string, commandKey: string) {
  const key = process.env.FORGE_LOOP_WEBHOOK_SECRET
  if (!key || key.length < 32)
    throw new LoopPolicyError("Webhook secret generation is not configured.")
  return createHmac("sha256", key)
    .update(`${loopId}:${commandKey}`)
    .digest("base64url")
}
function project(row: typeof teamLoops.$inferSelect): SharedLoop {
  return {
    ...loopFieldsSchema.parse(row.fields),
    id: row.id,
    revision: row.revision,
    enabled: row.enabled,
    enabledById: row.enabledById,
    updatedAt: row.updatedAt.toISOString(),
  }
}
export async function readLoops(
  actor: Actor,
  teamId: string
): Promise<LoopSnapshot> {
  z.uuid().parse(teamId)
  if (!loopsEnabled()) return { enabled: false, loops: [], runs: [] }
  return db.transaction(async (tx) => {
    actor = await currentCommandActor(tx, actor)
    await loopTeamAccess(tx, actor, teamId)
    const rows = await tx
      .select()
      .from(teamLoops)
      .where(
        and(
          eq(teamLoops.workspaceId, actor.workspaceId),
          eq(teamLoops.teamId, teamId),
          isNull(teamLoops.deletedAt)
        )
      )
      .orderBy(desc(teamLoops.updatedAt))
      .limit(100)
    const runs = await tx
      .select({ run: loopRuns })
      .from(loopRuns)
      .innerJoin(
        teamLoops,
        and(
          eq(teamLoops.id, loopRuns.loopId),
          eq(teamLoops.workspaceId, loopRuns.workspaceId)
        )
      )
      .where(
        and(
          eq(teamLoops.workspaceId, actor.workspaceId),
          eq(teamLoops.teamId, teamId),
          isNull(teamLoops.deletedAt)
        )
      )
      .orderBy(desc(loopRuns.createdAt))
      .limit(100)
    const versions = await tx
      .select()
      .from(loopRevisions)
      .where(
        and(
          eq(loopRevisions.workspaceId, actor.workspaceId),
          inArray(
            loopRevisions.loopId,
            rows.map((r) => r.id)
          )
        )
      )
      .orderBy(desc(loopRevisions.createdAt))
      .limit(100)
    const approvals = runs.length
      ? await tx
          .select()
          .from(agentApprovals)
          .where(
            and(
              eq(agentApprovals.workspaceId, actor.workspaceId),
              inArray(
                agentApprovals.runId,
                runs.map((x) => x.run.agentRunId)
              ),
              eq(agentApprovals.state, "pending"),
              gt(agentApprovals.expiresAt, new Date())
            )
          )
      : []
    const { loopChoices } = await import("./loop-choices.server")
    const { manualLoopContext } = await import("./loop-context.server")
    const visibility = new Map<string, boolean>()
    const visibleRuns = new Set<string>()
    for (const { run } of runs) {
      const event = run.event,
        loop = rows.find((l) => l.id === run.loopId)
      if (!loop) continue
      if (
        typeof event.entity !== "string" ||
        typeof event.entityId !== "string" ||
        !["issue", "project", "initiative", "cycle", "team"].includes(
          event.entity
        )
      ) {
        visibleRuns.add(run.id)
        continue
      }
      const access =
        loop.fields.teamAccess === "all-public-teams" &&
        run.fields.teamAccess === "all-public-teams"
          ? "all-public-teams"
          : "this-team"
      const key = JSON.stringify([event.entity, event.entityId, access])
      if (!visibility.has(key)) {
        try {
          await manualLoopContext(
            tx,
            actor,
            {
              ...loop,
              fields: {
                ...loop.fields,
                teamAccess: access,
                trigger: {
                  kind: "event",
                  entity: event.entity as
                    "issue" | "project" | "initiative" | "cycle" | "team",
                  event: "created",
                },
              },
            },
            event.entityId
          )
          visibility.set(key, true)
        } catch (error) {
          if (
            error instanceof ApplicationAccessError ||
            error instanceof LoopPolicyError
          )
            visibility.set(key, false)
          else throw error
        }
      }
      if (visibility.get(key)) visibleRuns.add(run.id)
    }
    return {
      enabled: true,
      choices: await loopChoices(tx, actor, teamId),
      versions: versions.map((v) => ({
        loopId: v.loopId,
        revision: v.revision,
        fields: v.fields,
        publishedAt: v.createdAt.toISOString(),
      })),
      loops: rows.map(project),
      runs: runs.map(({ run: r }) => ({
        id: r.id,
        loopId: r.loopId,
        state: r.state,
        createdAt: r.createdAt.toISOString(),
        errorCode: visibleRuns.has(r.id) ? r.errorCode : "SOURCE_UNAVAILABLE",
        threadId: r.startedAt && visibleRuns.has(r.id) ? r.threadId : null,
        result: visibleRuns.has(r.id) ? r.result : null,
        approvals: approvals
          .filter((a) => visibleRuns.has(r.id) && a.runId === r.agentRunId)
          .map((a) => ({
            id: a.id,
            inputHash: a.inputHash,
            summary:
              typeof a.redactedInputSummary.summary === "string"
                ? a.redactedInputSummary.summary
                : "Review this tool action",
          })),
      })),
    }
  })
}
class LoopConflict extends Error {}
export async function enqueueLoopRun(
  tx: Transaction,
  row: typeof teamLoops.$inferSelect,
  key: string,
  event: Record<string, unknown>
) {
  if (!row.enabled || !row.enabledById)
    throw new ApplicationAccessError("Enable this Loop before running it.")
  const inputHash = commandInputHash(event)
  const inserted = (
    await tx
      .insert(loopRuns)
      .values({
        workspaceId: row.workspaceId,
        loopId: row.id,
        loopRevision: row.revision,
        eventKey: key,
        eventHash: inputHash,
        event,
        fields: row.fields,
        authorizerId: row.enabledById,
      })
      .onConflictDoNothing()
      .returning()
  )[0]
  if (inserted) return inserted
  const old = (
    await tx
      .select()
      .from(loopRuns)
      .where(and(eq(loopRuns.loopId, row.id), eq(loopRuns.eventKey, key)))
  )[0]
  if (!old || old.eventHash !== inputHash)
    throw new LoopPolicyError(
      "The event identity was already used with different input."
    )
  return old
}
export async function commandLoop(
  actor: Actor,
  teamId: string,
  key: string,
  raw: unknown
): Promise<LoopCommandResult> {
  z.uuid().parse(teamId)
  z.uuid().parse(key)
  const input = loopCommandSchema.parse(
    withoutUndefined(loopCommandSchema.parse(raw))
  )
  try {
    if (input.action === "enable") {
      const { requireCurrentActor } =
        await import("@/application/resource-policy.server")
      const { assertLoopCanEnable } = await import("./loop-execution.server")
      await assertLoopCanEnable(await requireCurrentActor(actor))
    }
    const secret =
      input.action === "rotate-webhook"
        ? webhookSecret(input.id, key)
        : undefined
    const result = await executeCommand({
      actor,
      commandKey: key,
      operation: "loops.write@1",
      input: { teamId, ...input },
      status: 200,
      parse: (value) =>
        z
          .object({ id: z.uuid(), revision: z.number().int().positive() })
          .strict()
          .parse(value),
      authorize: async (tx, current) => {
        const team = await loopTeamAccess(tx, current, teamId)
        const { canWorkspaceAction } =
          await import("@/application/workspace-security/workspace-security.server")
        if (
          [
            "create",
            "save",
            "enable",
            "disable",
            "delete",
            "rotate-webhook",
          ].includes(input.action) &&
          !(await canWorkspaceAction(current, "loops.manage", tx))
        )
          throw new ApplicationAccessError(
            "Workspace security policy restricts Loop management."
          )
        if (
          [
            "create",
            "save",
            "enable",
            "run-now",
            "approve",
            "deny",
            "rotate-webhook",
          ].includes(input.action)
        ) {
          if (!(await canWorkspaceAction(current, "agents.invoke", tx)))
            throw new ApplicationAccessError(
              "Workspace security policy does not allow agent execution."
            )
        }
        if (
          (input.action === "create" || input.action === "save") &&
          team.visibility === "private" &&
          input.fields.teamAccess !== "this-team"
        )
          throw new ApplicationAccessError(
            "Private-team Loops must stay within that team."
          )
        if (input.action !== "create") {
          const row = (
            await tx
              .select()
              .from(teamLoops)
              .where(
                and(
                  eq(teamLoops.id, input.id),
                  eq(teamLoops.workspaceId, current.workspaceId),
                  eq(teamLoops.teamId, teamId)
                )
              )
              .for("share")
          )[0]
          if (!row || (row.deletedAt && input.action !== "delete"))
            throw new ApplicationAccessError()
        }
      },
      run: async (tx, current) => {
        const old = (
          await tx
            .select()
            .from(teamLoops)
            .where(eq(teamLoops.id, input.id))
            .for("update")
        )[0]
        if (
          input.action === "create"
            ? !!old
            : !old || !!old.deletedAt || old.revision !== input.expectedRevision
        )
          throw new LoopConflict()
        const now = new Date()
        if (
          (input.action === "enable" &&
            old.fields.trigger.kind === "webhook") ||
          (input.action === "save" &&
            old.enabled &&
            input.fields.trigger.kind === "webhook")
        ) {
          const { canWorkspaceAction } =
            await import("@/application/workspace-security/workspace-security.server")
          if (
            !(await canWorkspaceAction(current, "loops.trigger-external", tx))
          )
            throw new LoopPolicyError(
              "Enable external Loop sources in workspace security before enabling a webhook Loop."
            )
        }
        if (
          (input.action === "create" || input.action === "save") &&
          input.fields.trigger.kind === "schedule" &&
          new Date(input.fields.trigger.startAt) < now &&
          (input.action === "create" ||
            old?.fields.trigger.kind !== "schedule" ||
            old.fields.trigger.startAt !== input.fields.trigger.startAt)
        )
          throw new LoopPolicyError(
            "Choose a first run in the future for a new schedule."
          )
        let revision = old?.revision ?? 0
        if (input.action === "create") {
          const count = await tx
            .select({ id: teamLoops.id })
            .from(teamLoops)
            .where(
              and(eq(teamLoops.teamId, teamId), isNull(teamLoops.deletedAt))
            )
          if (count.length >= 100)
            throw new LoopPolicyError("A team can have up to 100 Loops.")
          revision = 1
          await tx
            .insert(users)
            .values({
              id: loopPrincipalId(input.id),
              name: "Forge Loop",
              email: `loop-${input.id}@automation.invalid`,
              emailVerified: false,
            })
            .onConflictDoNothing()
          await tx.insert(teamLoops).values({
            id: input.id,
            workspaceId: current.workspaceId,
            teamId,
            fields: input.fields,
            revision,
            enabled: false,
          })
        } else if (input.action === "run-now") {
          if (
            old.fields.trigger.kind === "webhook" ||
            (old.fields.trigger.kind === "event" &&
              (old.fields.trigger.entity === "cycle" ||
                ["comment", "update"].includes(old.fields.trigger.event)))
          )
            throw new LoopPolicyError("This trigger does not support Run now.")
          const { manualLoopContext } = await import("./loop-context.server")
          const context = await manualLoopContext(
            tx,
            current,
            old,
            input.entityId
          )
          await enqueueLoopRun(tx, old, `manual:${key}`, context)
        } else if (
          input.action === "approve" ||
          input.action === "deny" ||
          input.action === "cancel-run"
        ) {
          const run = (
            await tx
              .select()
              .from(loopRuns)
              .where(
                and(
                  eq(loopRuns.id, input.runId),
                  eq(loopRuns.loopId, old.id),
                  eq(loopRuns.workspaceId, current.workspaceId)
                )
              )
              .for("update")
          )[0]
          if (!run) throw new ApplicationAccessError()
          if (input.action === "cancel-run" && run.state === "queued")
            await tx
              .update(loopRuns)
              .set({ state: "cancelled", finishedAt: now })
              .where(eq(loopRuns.id, run.id))
          else {
            if (
              !["running", "waiting-for-approval"].includes(run.state) ||
              run.pendingDecision
            )
              throw new LoopPolicyError(
                "This run changed. Refresh its history before continuing."
              )
            if (input.action !== "cancel-run") {
              const approval = (
                await tx
                  .select()
                  .from(agentApprovals)
                  .where(
                    and(
                      eq(agentApprovals.id, input.approvalId),
                      eq(agentApprovals.runId, run.agentRunId),
                      eq(agentApprovals.state, "pending"),
                      eq(agentApprovals.inputHash, input.inputHash),
                      gt(agentApprovals.expiresAt, now)
                    )
                  )
                  .for("share")
              )[0]
              if (!approval)
                throw new LoopPolicyError(
                  "This approval changed or expired. Refresh the run history."
                )
            }
            await tx
              .update(loopRuns)
              .set({
                pendingDecision: {
                  action: input.action,
                  requestedById: current.userId,
                  ...(input.action !== "cancel-run"
                    ? {
                        approvalId: input.approvalId,
                        inputHash: input.inputHash,
                      }
                    : {}),
                },
              })
              .where(eq(loopRuns.id, run.id))
          }
        } else {
          revision++
          const enable = input.action === "enable"
          if (
            enable &&
            old.fields.trigger.kind === "webhook" &&
            !old.webhookSecretHash
          )
            throw new LoopPolicyError(
              "Generate a webhook secret before enabling this Loop."
            )
          if (
            input.action === "rotate-webhook" &&
            old.fields.trigger.kind !== "webhook"
          )
            throw new LoopPolicyError(
              "Only webhook Loops have webhook secrets."
            )
          const fields = input.action === "save" ? input.fields : old.fields
          await tx
            .update(teamLoops)
            .set({
              revision,
              updatedAt: now,
              ...(input.action === "save"
                ? {
                    fields,
                    nextRunAt:
                      old.enabled && fields.trigger.kind === "schedule"
                        ? nextLoopScheduledAt(fields.trigger, now)
                        : null,
                  }
                : {}),
              ...(enable
                ? {
                    enabled: true,
                    enabledById: current.userId,
                    enabledAt: now,
                    nextRunAt:
                      fields.trigger.kind === "schedule"
                        ? nextLoopScheduledAt(
                            fields.trigger,
                            new Date(now.getTime() - 1)
                          )
                        : null,
                  }
                : {}),
              ...(["disable", "delete"].includes(input.action)
                ? { enabled: false, nextRunAt: null }
                : {}),
              ...(input.action === "delete" ? { deletedAt: now } : {}),
              ...(secret ? { webhookSecretHash: webhookHash(secret) } : {}),
            })
            .where(eq(teamLoops.id, input.id))
        }
        if (input.action === "disable" || input.action === "delete") {
          await tx
            .update(loopRuns)
            .set({ state: "cancelled", finishedAt: now })
            .where(
              and(eq(loopRuns.loopId, input.id), eq(loopRuns.state, "queued"))
            )
          await tx
            .update(loopRuns)
            .set({ pendingDecision: { action: "cancel-run" } })
            .where(
              and(
                eq(loopRuns.loopId, input.id),
                inArray(loopRuns.state, ["running", "waiting-for-approval"])
              )
            )
        }
        if (input.action === "create" || input.action === "save")
          await tx.insert(loopRevisions).values({
            workspaceId: current.workspaceId,
            loopId: input.id,
            revision,
            fields: input.fields,
            authorId: current.userId,
          })
        return {
          value: { id: input.id, revision },
          resource: { type: "loop", id: input.id },
          events: [
            {
              topic: `loop.${input.action}`,
              payload: {
                loopId: input.id,
                teamId,
                revision,
                ...("runId" in input
                  ? { runId: input.runId, requestedById: current.userId }
                  : {}),
                ...("approvalId" in input
                  ? { approvalId: input.approvalId }
                  : {}),
              },
            },
          ],
        }
      },
    })
    return {
      status: "saved",
      ...result.value,
      ...(secret ? { webhookSecret: secret } : {}),
    }
  } catch (e) {
    if (!(e instanceof LoopConflict)) throw e
    const current =
      (await readLoops(actor, teamId)).loops.find((x) => x.id === input.id) ??
      null
    return { status: "conflict", current }
  }
}
