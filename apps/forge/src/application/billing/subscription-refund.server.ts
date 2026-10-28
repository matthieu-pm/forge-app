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
  workspaceId: z.string().min(1),
  environment: z.enum(["sandbox", "production"]),
  orderId: z.uuid(),
  subscriptionId: z.uuid(),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  refundedAt: z.iso.datetime({ offset: true }),
})
export type VerifiedPeriodRefund = z.infer<typeof refundSchema>

/** Append provider-verified denial independently of mutable subscription status. */
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
  const { workspaceId, ...refund } = refundSchema.parse(input.refund)
  if (new Date(refund.start) >= new Date(refund.end))
    throw new Error("BILLING_REFUND_PERIOD_INVALID")
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
      return { outcome: duplicate.outcome, replayed: true }
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
        existing.end !== refund.end)
    )
      throw new Error("BILLING_REFUND_CONFLICT")
    const outcome = existing ? "unchanged" : "applied"
    if (!existing) {
      // This also records refunds arriving before first activation. Subscription
      // reconciliation deliberately never replaces this append-only history.
      const refundedPeriods = [...history, refund]
      await tx
        .insert(workspaceEntitlements)
        .values({ workspaceId, refundedPeriods })
        .onConflictDoUpdate({
          target: workspaceEntitlements.workspaceId,
          set: { refundedPeriods, updatedAt: new Date() },
        })
      await tx.insert(workspaceSecurityAuditEvents).values({
        workspaceId,
        action: "billing.subscription_period.refunded",
        target: refund.orderId,
        outcome: "succeeded",
        after: refund,
        requestId: eventId,
      })
    }
    await tx.insert(billingEventReceipts).values({
      workspaceId,
      environment: refund.environment,
      eventId,
      bodyHash,
      subscriptionId: refund.subscriptionId,
      outcome,
    })
    return { outcome, replayed: false }
  })
}
