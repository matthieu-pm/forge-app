import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import {
  billingEventReceipts,
  db,
  organizations,
  workspaceEntitlements,
  workspaceSecurityAuditEvents,
} from "@/db"

const refundSchema = z.object({
  kind: z.enum(["full", "partial"]).default("full"),
  scope: z.enum(["period", "upgrade"]).default("period"),
  starterBasis: z
    .object({
      orderId: z.uuid(),
      start: z.iso.datetime({ offset: true }),
      end: z.iso.datetime({ offset: true }),
    })
    .optional(),
  workspaceId: z.string().min(1),
  environment: z.enum(["sandbox", "production"]),
  orderId: z.uuid(),
  subscriptionId: z.uuid(),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  refundedAt: z.iso.datetime({ offset: true }),
})
export type VerifiedPeriodRefund = z.input<typeof refundSchema>

/** Reconcile provider-verified refunds without deriving access from event payloads. */
export async function applyVerifiedPeriodRefund(input: {
  eventId: string
  bodyHash: string
  refund: VerifiedPeriodRefund
}) {
  const eventId = z.string().trim().min(1).max(255).parse(input.eventId)
  const bodyHash = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.bodyHash)
  const { workspaceId, kind, scope, starterBasis, ...refund } =
    refundSchema.parse(input.refund)
  if (new Date(refund.start) >= new Date(refund.end))
    throw new Error("BILLING_REFUND_PERIOD_INVALID")
  if (
    starterBasis &&
    (scope !== "upgrade" ||
      new Date(starterBasis.start) > new Date(refund.start) ||
      new Date(starterBasis.start) >= new Date(starterBasis.end) ||
      new Date(starterBasis.end).getTime() !== new Date(refund.end).getTime())
  )
    throw new Error("BILLING_STARTER_BASE_INVALID")
  return db.transaction(async (tx) => {
    const workspace = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, workspaceId))
      .for("update")
    if (!workspace.length) throw new Error("BILLING_WORKSPACE_NOT_FOUND")
    const duplicate = await tx.query.billingEventReceipts.findFirst({
      where: and(
        eq(billingEventReceipts.environment, refund.environment),
        eq(billingEventReceipts.eventId, eventId)
      ),
    })
    if (duplicate) {
      if (
        duplicate.bodyHash !== bodyHash ||
        duplicate.workspaceId !== workspaceId ||
        duplicate.subscriptionId !== refund.subscriptionId
      )
        throw new Error("BILLING_EVENT_CONFLICT")
    }
    const previous = await tx.query.workspaceEntitlements.findFirst({
      where: eq(workspaceEntitlements.workspaceId, workspaceId),
    })
    const history = previous?.refundedPeriods ?? []
    const existing = history.find(
      (p) =>
        p.environment === refund.environment && p.orderId === refund.orderId
    )
    if (
      existing &&
      (existing.subscriptionId !== refund.subscriptionId ||
        existing.start !== refund.start ||
        existing.end !== refund.end ||
        (existing.kind === "upgrade") !== (scope === "upgrade") ||
        (existing.starterOrderId &&
          starterBasis &&
          existing.starterOrderId !== starterBasis.orderId))
    )
      throw new Error("BILLING_REFUND_CONFLICT")
    const restoreBase =
      scope === "upgrade" &&
      kind === "full" &&
      !!starterBasis &&
      !!existing &&
      !existing.starterOrderId
    const change = kind === "full" && (!existing || restoreBase)
    if (duplicate && !change)
      return { outcome: duplicate.outcome, replayed: true }
    const outcome = change ? "applied" : "unchanged"
    if (change) {
      const marker =
        scope === "upgrade"
          ? {
              ...refund,
              kind: "upgrade" as const,
              starterOrderId: starterBasis?.orderId ?? null,
              basePeriodStart: starterBasis?.start,
              basePeriodEnd: starterBasis?.end,
            }
          : refund
      const refundedPeriods = existing
        ? history.map((period) => (period === existing ? marker : period))
        : [...history, marker]
      const affectsCurrent =
        scope === "upgrade" &&
        previous?.source === "polar" &&
        previous.providerEnvironment === refund.environment &&
        previous.sourceReference === refund.subscriptionId &&
        previous.currentPeriodStart &&
        previous.currentPeriodEnd &&
        new Date(refund.start) < previous.currentPeriodEnd &&
        new Date(refund.end) > previous.currentPeriodStart &&
        (!previous.paidUpgradeOrderId ||
          previous.paidUpgradeOrderId === refund.orderId)
      const downgrade = affectsCurrent
        ? { plan: "basic", paidUpgradeOrderId: null }
        : {}
      await tx
        .insert(workspaceEntitlements)
        .values({ workspaceId, refundedPeriods })
        .onConflictDoUpdate({
          target: workspaceEntitlements.workspaceId,
          set: { refundedPeriods, updatedAt: new Date(), ...downgrade },
        })
    }
    if (change || kind === "partial")
      await tx.insert(workspaceSecurityAuditEvents).values({
        workspaceId,
        action:
          kind === "partial"
            ? "billing.subscription_period.partially_refunded"
            : scope === "upgrade"
              ? "billing.upgrade_charge.refunded"
              : "billing.subscription_period.refunded",
        target: refund.orderId,
        outcome: "succeeded",
        after: { ...refund, kind, scope, starterBasis: starterBasis ?? null },
        requestId: eventId,
      })
    if (duplicate) {
      await tx
        .update(billingEventReceipts)
        .set({ outcome })
        .where(
          and(
            eq(billingEventReceipts.environment, refund.environment),
            eq(billingEventReceipts.eventId, eventId)
          )
        )
    } else
      await tx.insert(billingEventReceipts).values({
        workspaceId,
        environment: refund.environment,
        eventId,
        bodyHash,
        subscriptionId: refund.subscriptionId,
        outcome,
      })
    return { outcome, replayed: !!duplicate }
  })
}
