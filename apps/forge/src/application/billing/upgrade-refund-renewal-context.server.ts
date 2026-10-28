import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import {
  billingEventReceipts,
  db,
  organizations,
  workspaceEntitlements,
  workspaceSecurityAuditEvents,
} from "@/db"

const inputSchema = z.object({
  workspaceId: z.string().min(1),
  environment: z.enum(["sandbox", "production"]),
  subscriptionId: z.uuid(),
  orderId: z.uuid(),
})
export type RefundRenewalIdentity = z.infer<typeof inputSchema>
type State = typeof workspaceEntitlements.$inferSelect
export type RefundRenewalContext =
  | { status: "superseded" | "terminated" }
  | { status: "required"; start: string; end: string; revision: string }

function contextFor(
  input: RefundRenewalIdentity,
  state: State | undefined
): RefundRenewalContext {
  const marker = state?.refundedPeriods.find(
    (p) =>
      p.kind === "upgrade" &&
      p.environment === input.environment &&
      p.subscriptionId === input.subscriptionId &&
      p.orderId === input.orderId
  )
  if (!marker) throw new Error("BILLING_VERIFIED_UPGRADE_REFUND_REQUIRED")
  if (state?.source !== "polar")
    throw new Error("BILLING_REFUND_BINDING_REQUIRED")
  if (
    state.providerEnvironment !== input.environment ||
    state.sourceReference !== input.subscriptionId
  )
    return { status: "superseded" }
  if (state.terminatedAt) return { status: "terminated" }
  if (state.paidUpgradeOrderId && state.paidUpgradeOrderId !== input.orderId)
    return { status: "superseded" }
  const start = state.currentPeriodStart?.toISOString(),
    end = state.currentPeriodEnd?.toISOString()
  if (!start || !end) throw new Error("BILLING_REFUND_BINDING_REQUIRED")
  const refundStart = new Date(marker.start).getTime(),
    refundEnd = new Date(marker.end).getTime()
  if (
    !Number.isFinite(refundStart) ||
    !Number.isFinite(refundEnd) ||
    refundStart >= refundEnd
  )
    throw new Error("BILLING_REFUND_RENEWAL_PERIOD_CONFLICT")
  if (state.currentPeriodStart!.getTime() >= refundEnd)
    return { status: "superseded" }
  if (
    state.currentPeriodStart!.getTime() > refundStart ||
    state.currentPeriodEnd!.getTime() !== refundEnd
  )
    throw new Error("BILLING_REFUND_RENEWAL_PERIOD_CONFLICT")
  return {
    status: "required",
    start,
    end,
    revision: createHash("sha256")
      .update(
        JSON.stringify({
          ...input,
          start,
          end,
          refundedAt: marker.refundedAt,
          paidOrder: state.paidUpgradeOrderId,
          terminatedAt: state.terminatedAt,
        })
      )
      .digest("hex"),
  }
}

export async function readUpgradeRefundRenewalContext(
  value: RefundRenewalIdentity
) {
  const input = inputSchema.parse(value)
  return contextFor(
    input,
    await db.query.workspaceEntitlements.findFirst({
      where: eq(workspaceEntitlements.workspaceId, input.workspaceId),
    })
  )
}

const confirmationSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  effectiveAt: z.iso.datetime({ offset: true }),
  providerUpdatedAt: z.iso.datetime({ offset: true }),
  currency: z.enum(["eur", "usd"]),
  productId: z.uuid(),
  billedSeats: z.number().int().positive().safe(),
  renewalSeats: z.number().int().positive().safe(),
  status: z.enum(["scheduled", "already-starter"]),
})
export type RefundRenewalConfirmation = z.infer<typeof confirmationSchema>

/** Intent is the durable verified refund marker; confirmation never grants access. */
export async function confirmUpgradeRefundRenewal(
  value: RefundRenewalIdentity,
  proof: RefundRenewalConfirmation
) {
  const input = inputSchema.parse(value),
    confirmed = confirmationSchema.parse(proof)
  return db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, input.workspaceId))
      .for("update")
    if (!locked.length) throw new Error("BILLING_WORKSPACE_NOT_FOUND")
    const current = contextFor(
      input,
      await tx.query.workspaceEntitlements.findFirst({
        where: eq(workspaceEntitlements.workspaceId, input.workspaceId),
      })
    )
    if (current.status !== "required")
      return { status: current.status, replayed: false }
    if (
      current.revision !== confirmed.revision ||
      current.end !== new Date(confirmed.effectiveAt).toISOString()
    )
      throw new Error("BILLING_REFUND_RENEWAL_CONTEXT_CHANGED")
    const eventId = `forge.refund-renewal.${input.orderId}.${confirmed.providerUpdatedAt}.${confirmed.renewalSeats}`
    const bodyHash = createHash("sha256")
      .update(JSON.stringify({ ...input, ...confirmed }))
      .digest("hex")
    const duplicate = await tx.query.billingEventReceipts.findFirst({
      where: and(
        eq(billingEventReceipts.environment, input.environment),
        eq(billingEventReceipts.eventId, eventId)
      ),
    })
    if (duplicate) {
      if (
        duplicate.bodyHash !== bodyHash ||
        duplicate.workspaceId !== input.workspaceId ||
        duplicate.subscriptionId !== input.subscriptionId
      )
        throw new Error("BILLING_EVENT_CONFLICT")
      return { status: confirmed.status, replayed: true }
    }
    await tx.insert(workspaceSecurityAuditEvents).values({
      workspaceId: input.workspaceId,
      action: "billing.upgrade_refund.renewal_confirmed",
      target: input.orderId,
      outcome: "succeeded",
      requestId: eventId,
      after: {
        ...confirmed,
        target: "starter",
        subscriptionId: input.subscriptionId,
      },
    })
    await tx.insert(billingEventReceipts).values({
      workspaceId: input.workspaceId,
      environment: input.environment,
      subscriptionId: input.subscriptionId,
      eventId,
      bodyHash,
      outcome: "applied",
    })
    return { status: confirmed.status, replayed: false }
  })
}
