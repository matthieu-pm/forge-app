import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { z } from "zod"
import { resolveWorkspaceUsageAuthority } from "./usage-authority"
import { workspaceUsagePeriod } from "./workspace-usage-period"
import { workspaceAiAllowanceMicros } from "./workspace-ai-budget"
import { workspaceUsageChargePolicy } from "./forge-billable-usage"
import type { Actor } from "@/application/actor"
import type { WorkspaceUsagePeriod } from "./workspace-usage-period"
import { isAgentInvocationAllowed } from "@/application/workspace-security/security-policy"
import { requireAgentRun } from "@/application/agents/agent-authorization"
import { hasWorkspaceRole } from "@/application/authorization"
import {
  agentEvents,
  agentRuns,
  agentThreads,
  db,
  members,
  modelCatalogEntries,
  modelConnections,
  organizations,
  users,
  workspaceEntitlements,
  workspaceMemberCapacity,
  workspaceSecurityAuditEvents,
  workspaceSecuritySettings,
  workspaceUsageCarryovers,
  workspaceUsagePeriods,
  workspaceUsageReceipts,
  workspaceUsageReservations,
} from "@/db"

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type PeriodRow = typeof workspaceUsagePeriods.$inferSelect
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")
const admissionSchema = z.strictObject({
  requestId: z.uuid(),
  runId: z.uuid(),
  threadId: z.uuid(),
  connectionId: z.uuid(),
  modelId: z.string().min(1).max(255),
  maximumCostUsdMicros: money,
  pricingFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
})
export type AgentUsageAdmission = z.infer<typeof admissionSchema>

async function fence<T>(
  workspaceId: string,
  action: (
    tx: Tx,
    workspace: { id: string; createdAt: Date },
    now: Date
  ) => Promise<T>
) {
  return db.transaction(async (tx) => {
    const workspace = (
      await tx
        .select({ id: organizations.id, createdAt: organizations.createdAt })
        .from(organizations)
        .where(eq(organizations.id, workspaceId))
        .for("no key update")
    ).at(0)
    if (!workspace) throw new Error("USAGE_WORKSPACE_NOT_FOUND")
    const clock = await tx.execute<{ at: string }>(
      sql`SELECT clock_timestamp() AS at`
    )
    return action(tx, workspace, z.coerce.date().parse(clock.rows.at(0)?.at))
  })
}
async function period(
  tx: Tx,
  workspaceId: string,
  kind: "free" | "trial" | "paid",
  binding: string,
  window: WorkspaceUsagePeriod
) {
  const key = JSON.stringify(["forge.usage-account", kind, window.key])
  await tx
    .insert(workspaceUsagePeriods)
    .values({
      workspaceId,
      kind,
      binding,
      periodKey: key,
      startedAt: window.start,
      endsAt: window.end,
    })
    .onConflictDoNothing()
  const row = await tx.query.workspaceUsagePeriods.findFirst({
    where: and(
      eq(workspaceUsagePeriods.workspaceId, workspaceId),
      eq(workspaceUsagePeriods.periodKey, key)
    ),
  })
  if (
    !row ||
    row.kind !== kind ||
    row.binding !== binding ||
    row.startedAt.getTime() !== window.start.getTime() ||
    row.endsAt.getTime() !== window.end.getTime()
  )
    throw new Error("USAGE_PERIOD_BINDING_CONFLICT")
  return row
}
async function authority(
  tx: Tx,
  workspace: { id: string; createdAt: Date },
  now: Date
) {
  const state = await tx.query.workspaceEntitlements.findFirst({
    where: eq(workspaceEntitlements.workspaceId, workspace.id),
  })
  const access = resolveWorkspaceUsageAuthority({
    workspaceId: workspace.id,
    workspaceCreatedAt: workspace.createdAt,
    state: state ?? null,
    now,
  })
  const candidates = await tx
    .select()
    .from(workspaceUsagePeriods)
    .where(eq(workspaceUsagePeriods.workspaceId, workspace.id))
    .orderBy(desc(workspaceUsagePeriods.startedAt))
  let account: PeriodRow
  if (access.grace) {
    const row = candidates.find(
      (p) =>
        p.kind === "paid" &&
        p.binding === access.binding &&
        ((p.startedAt.getTime() === state?.currentPeriodStart?.getTime() &&
          p.endsAt.getTime() === state.currentPeriodEnd?.getTime()) ||
          p.endsAt.getTime() === state?.currentPeriodStart?.getTime() ||
          p.endsAt.getTime() === state?.paymentFailedAt?.getTime())
    )
    if (!row) throw new Error("USAGE_GRACE_ORIGINAL_PERIOD_REQUIRED")
    account = row
  } else {
    if (!access.period) throw new Error("USAGE_PERIOD_RECONCILIATION_REQUIRED")
    account = await period(
      tx,
      workspace.id,
      access.kind,
      access.binding,
      access.period
    )
  }
  const transition = access.transition
  if (transition) {
    const source = candidates.find(
      (p) =>
        p.kind === (transition.kind === "trial-expiry" ? "trial" : "paid") &&
        p.binding === transition.binding &&
        ((p.startedAt.getTime() === transition.sourceStart.getTime() &&
          p.endsAt.getTime() === transition.sourceEnd.getTime()) ||
          (transition.failedAt &&
            (p.endsAt.getTime() === transition.sourceStart.getTime() ||
              p.endsAt.getTime() === transition.failedAt.getTime())))
    )
    if (source) {
      const target = await period(
        tx,
        workspace.id,
        "free",
        workspace.createdAt.toISOString(),
        workspaceUsagePeriod(workspace.id, transition.effectiveAt, {
          kind: "free",
          workspaceCreatedAt: workspace.createdAt,
        })
      )
      await tx
        .insert(workspaceUsageCarryovers)
        .values({
          workspaceId: workspace.id,
          sourcePeriodId: source.id,
          targetPeriodId: target.id,
          kind: transition.kind,
          effectiveAt: transition.effectiveAt,
        })
        .onConflictDoNothing()
      const saved = await tx.query.workspaceUsageCarryovers.findFirst({
        where: eq(workspaceUsageCarryovers.sourcePeriodId, source.id),
      })
      if (
        !saved ||
        saved.targetPeriodId !== target.id ||
        saved.effectiveAt.getTime() !== transition.effectiveAt.getTime()
      )
        throw new Error("USAGE_TRANSITION_RECONCILIATION_REQUIRED")
    }
  }
  const carry = await tx
    .select({ source: workspaceUsageCarryovers.sourcePeriodId })
    .from(workspaceUsageCarryovers)
    .where(
      and(
        eq(workspaceUsageCarryovers.workspaceId, workspace.id),
        eq(workspaceUsageCarryovers.targetPeriodId, account.id)
      )
    )
  const ids = [account.id, ...carry.map((c) => c.source)]
  const totals = await tx
    .select({
      settled: sql<string>`coalesce(sum(${workspaceUsageReservations.settledUsdMicros}),0)::text`,
      reserved: sql<string>`coalesce(sum(${workspaceUsageReservations.reservedUsdMicros}),0)::text`,
    })
    .from(workspaceUsageReservations)
    .where(
      and(
        eq(workspaceUsageReservations.workspaceId, workspace.id),
        eq(workspaceUsageReservations.usesPool, true),
        inArray(workspaceUsageReservations.periodId, ids)
      )
    )
  const total = totals.at(0)
  const settled = money.parse(Number(total?.settled ?? 0)),
    reserved = money.parse(Number(total?.reserved ?? 0))
  money.parse(settled + reserved)
  return { access, account, settled, reserved, carrySourceCount: carry.length }
}

/** Internal only. The caller must supply a trusted bounded pricing quote, not
 * request/browser amounts. No public handler or live runtime uses this until
 * provider quote/dispatch settlement and paid overage contracts are integrated. */
export async function admitAgentRunWithUsage(
  actor: Actor,
  value: AgentUsageAdmission
) {
  requireAgentRun(actor)
  if (actor.authentication.kind !== "session")
    throw new Error("USAGE_FIRST_PARTY_SESSION_REQUIRED")
  const input = admissionSchema.parse(value)
  const bodyHash = hash({
    actorUserId: actor.userId,
    workspaceId: actor.workspaceId,
    ...input,
  })
  return fence(actor.workspaceId, async (tx, workspace, now) => {
    const user = (
      await tx
        .select({ verified: users.emailVerified })
        .from(users)
        .where(eq(users.id, actor.userId))
        .for("share")
    ).at(0)
    const member = (
      await tx
        .select({ role: members.role })
        .from(members)
        .where(
          and(
            eq(members.organizationId, workspace.id),
            eq(members.userId, actor.userId)
          )
        )
        .for("share")
    ).at(0)
    if (
      !member ||
      !hasWorkspaceRole({ ...actor, workspaceRole: member.role }, [
        "owner",
        "admin",
        "member",
        "guest",
      ])
    )
      throw new Error("USAGE_ACTOR_REVOKED")
    if (!user?.verified) throw new Error("USAGE_EMAIL_VERIFICATION_REQUIRED")
    const settings = (
      await tx
        .select({
          blockGuests: workspaceSecuritySettings.blockGuestAgentAccess,
        })
        .from(workspaceSecuritySettings)
        .where(eq(workspaceSecuritySettings.workspaceId, workspace.id))
        .for("share")
    ).at(0)
    if (
      !isAgentInvocationAllowed(
        { ...actor, workspaceRole: member.role },
        { blockGuestAgentAccess: settings?.blockGuests ?? false }
      )
    )
      throw new Error("USAGE_GUEST_AGENT_ACCESS_DENIED")
    const prior = await tx.query.workspaceUsageReservations.findFirst({
      where: eq(workspaceUsageReservations.requestId, input.requestId),
    })
    if (prior) {
      if (prior.workspaceId !== workspace.id || prior.requestHash !== bodyHash)
        throw new Error("USAGE_REQUEST_CONFLICT")
      return {
        reservationId: prior.id,
        runId: prior.operationId,
        periodId: prior.periodId,
        replayed: true,
      }
    }
    const thread = (
      await tx
        .select()
        .from(agentThreads)
        .where(
          and(
            eq(agentThreads.id, input.threadId),
            eq(agentThreads.workspaceId, workspace.id)
          )
        )
        .for("share")
    ).at(0)
    if (
      !thread ||
      thread.status !== "active" ||
      thread.createdByUserId !== actor.userId
    )
      throw new Error("USAGE_THREAD_NOT_FOUND")
    const connection = (
      await tx
        .select()
        .from(modelConnections)
        .where(
          and(
            eq(modelConnections.id, input.connectionId),
            eq(modelConnections.workspaceId, workspace.id)
          )
        )
        .for("share")
    ).at(0)
    if (
      !connection ||
      connection.status !== "ready" ||
      connection.locality !== "server-capable" ||
      connection.executionKind !== "forge-native" ||
      (connection.scope === "personal" && connection.userId !== actor.userId)
    )
      throw new Error("USAGE_MODEL_CONNECTION_UNAVAILABLE")
    const model = (
      await tx
        .select({
          id: modelCatalogEntries.id,
          expiresAt: modelCatalogEntries.expiresAt,
        })
        .from(modelCatalogEntries)
        .where(
          and(
            eq(modelCatalogEntries.connectionId, connection.id),
            eq(modelCatalogEntries.providerModelId, input.modelId),
            eq(modelCatalogEntries.status, "available")
          )
        )
        .for("share")
    ).at(0)
    if (!model || (model.expiresAt && model.expiresAt <= now))
      throw new Error("USAGE_MODEL_UNAVAILABLE")
    const capacity = (
      await tx
        .select({ count: workspaceMemberCapacity.activeMemberCount })
        .from(workspaceMemberCapacity)
        .where(eq(workspaceMemberCapacity.workspaceId, workspace.id))
        .for("share")
    ).at(0)
    if (!capacity || capacity.count < 1)
      throw new Error("USAGE_MEMBERSHIP_CAPACITY_REQUIRED")
    const budget = await authority(tx, workspace, now)
    const { usesWorkspaceAiPool } = workspaceUsageChargePolicy({
      plan: budget.access.plan,
      accessPhase: budget.access.phase,
      feature: "agent",
      billingMode: connection.billingMode,
    })
    if (usesWorkspaceAiPool && input.maximumCostUsdMicros === 0)
      throw new Error("USAGE_BOUNDED_PRICING_REQUIRED")
    const allowance = workspaceAiAllowanceMicros(
      budget.access.plan,
      capacity.count,
      budget.access.phase
    )
    const projected = money.parse(
      budget.settled +
        budget.reserved +
        (usesWorkspaceAiPool ? input.maximumCostUsdMicros : 0)
    )
    // Existing opted-in paid overage is deliberately not inferred from plan.
    // Its currency/consent/quote ledger must be integrated before permitting it.
    if (
      usesWorkspaceAiPool &&
      (budget.settled + budget.reserved >= allowance || projected > allowance)
    )
      throw new Error("USAGE_ALLOWANCE_EXHAUSTED")
    await tx.insert(agentRuns).values({
      id: input.runId,
      threadId: thread.id,
      initiatedByUserId: actor.userId,
      executionKind: connection.executionKind,
      requestedSelection: {
        mode: "manual",
        provider: connection.provider,
        billingMode: connection.billingMode,
      },
      resolvedConnectionId: connection.id,
      resolvedModelId: input.modelId,
    })
    await tx.insert(workspaceUsageReservations).values({
      id: input.runId,
      workspaceId: workspace.id,
      periodId: budget.account.id,
      requestId: input.requestId,
      requestHash: bodyHash,
      operationId: input.runId,
      runId: input.runId,
      actorUserId: actor.userId,
      provider: connection.provider,
      modelId: input.modelId,
      pricingFingerprint: input.pricingFingerprint,
      billingMode: connection.billingMode,
      feature: "agent",
      usesPool: usesWorkspaceAiPool,
      maximumCostUsdMicros: input.maximumCostUsdMicros,
      reservedUsdMicros: input.maximumCostUsdMicros,
    })
    await tx.insert(agentEvents).values({
      threadId: thread.id,
      runId: input.runId,
      source: "forge",
      sourceEventId: `${input.runId}:created`,
      sequence: 1,
      type: "run.created",
      schemaVersion: 1,
      payloadJson: { billingReservationId: input.runId },
      occurredAt: now,
    })
    await tx.insert(workspaceSecurityAuditEvents).values({
      workspaceId: workspace.id,
      actorUserId: actor.userId,
      action: "usage.agent.admitted",
      target: input.runId,
      outcome: "succeeded",
      requestId: input.requestId,
      after: {
        periodId: budget.account.id,
        usesPool: usesWorkspaceAiPool,
        maximumCostUsdMicros: input.maximumCostUsdMicros,
      },
    })
    return {
      reservationId: input.runId,
      runId: input.runId,
      periodId: budget.account.id,
      replayed: false,
    }
  })
}

const settlementSchema = z.strictObject({
  workspaceId: z.string().min(1),
  reservationId: z.uuid(),
  eventId: z.uuid(),
  outcome: z.enum(["settled", "confirmed-no-charge", "uncertain"]),
  providerCostUsdMicros: money,
})
/** Trusted provider/recovery sink. Uncertain cancellation retains exposure. */
export async function settleAgentUsage(
  value: z.infer<typeof settlementSchema>
) {
  const input = settlementSchema.parse(value),
    bodyHash = hash(input)
  if (input.outcome !== "settled" && input.providerCostUsdMicros !== 0)
    throw new Error("USAGE_SETTLEMENT_INVALID")
  return fence(input.workspaceId, async (tx) => {
    const prior = await tx.query.workspaceUsageReceipts.findFirst({
      where: eq(workspaceUsageReceipts.eventId, input.eventId),
    })
    if (prior) {
      if (
        prior.workspaceId !== input.workspaceId ||
        prior.reservationId !== input.reservationId ||
        prior.bodyHash !== bodyHash
      )
        throw new Error("USAGE_SETTLEMENT_CONFLICT")
      return { ...prior.result, replayed: true }
    }
    const held = await tx.query.workspaceUsageReservations.findFirst({
      where: and(
        eq(workspaceUsageReservations.workspaceId, input.workspaceId),
        eq(workspaceUsageReservations.id, input.reservationId)
      ),
    })
    if (!held) throw new Error("USAGE_RESERVATION_NOT_FOUND")
    if (!["held", "uncertain"].includes(held.state))
      throw new Error("USAGE_TERMINAL_RECONCILIATION_REQUIRED")
    const uncertain = input.outcome === "uncertain"
    const result = {
      state: uncertain
        ? "uncertain"
        : input.outcome === "confirmed-no-charge"
          ? "released"
          : input.providerCostUsdMicros > held.maximumCostUsdMicros
            ? "reconciliation-required"
            : "settled",
      settledUsdMicros: uncertain ? 0 : input.providerCostUsdMicros,
      reservedUsdMicros: uncertain ? held.maximumCostUsdMicros : 0,
    }
    await tx
      .update(workspaceUsageReservations)
      .set({ ...result, updatedAt: new Date() })
      .where(eq(workspaceUsageReservations.id, held.id))
    await tx.insert(workspaceUsageReceipts).values({
      eventId: input.eventId,
      workspaceId: input.workspaceId,
      reservationId: held.id,
      bodyHash,
      result,
    })
    await tx.insert(workspaceSecurityAuditEvents).values({
      workspaceId: input.workspaceId,
      actorUserId: null,
      action: "usage.agent.settled",
      target: held.id,
      outcome: "succeeded",
      requestId: input.eventId,
      after: result,
    })
    return { ...result, replayed: false }
  })
}

/** Internal reconciliation/read model. It creates no extra allowance grant. */
export async function inspectWorkspaceUsage(workspaceId: string) {
  return fence(workspaceId, async (tx, workspace, now) => {
    const result = await authority(tx, workspace, now)
    return {
      periodId: result.account.id,
      kind: result.account.kind,
      periodStart: result.account.startedAt,
      periodEnd: result.account.endsAt,
      settledUsdMicros: result.settled,
      reservedUsdMicros: result.reserved,
      carrySourceCount: result.carrySourceCount,
    }
  })
}
