import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import {
  PAYMENT_GRACE_MS,
  isRefundedSubscriptionPeriod,
  subscriptionAccess,
} from "./subscription-access"
import { workspaceBillingIdentity } from "./billing-authority"
import type { Actor } from "@/application/actor"
import { hasWorkspaceRole } from "@/application/authorization"
import {
  billingEventReceipts,
  db,
  organizations,
  workspaceEntitlements,
  workspaceSecurityAuditEvents,
} from "@/db"

const snapshotSchema = z.object({
  workspaceId: z.string().min(1),
  environment: z.enum(["sandbox", "production"]),
  subscriptionId: z.uuid(),
  plan: z.enum(["starter", "plus"]),
  status: z.enum(["active", "past_due", "canceled"]),
  updatedAt: z.date(),
  currentPeriodStart: z.date(),
  currentPeriodEnd: z.date(),
  pastDueAt: z.date().nullable(),
  cancelAtPeriodEnd: z.boolean().default(false),
  terminatedAt: z.date().nullable().default(null),
  paidUpgrade: z
    .object({
      orderId: z.uuid(),
      subscriptionId: z.uuid(),
      periodStart: z.date(),
      periodEnd: z.date(),
      createdAt: z.date(),
    })
    .optional(),
})
export type VerifiedSubscriptionSnapshot = z.input<typeof snapshotSchema>
const planChangeSchema = z.object({
  target: z.enum(["starter", "plus"]),
  status: z.enum([
    "applied",
    "scheduled",
    "unchanged",
    "payment-pending",
    "cleared",
  ]),
  effectiveAt: z.date().nullable(),
  renewalSeats: z.number().int().positive().safe(),
})
export type VerifiedPlanChange = z.infer<typeof planChangeSchema>

/** Server-only sink for provider-verified identity/catalog snapshots, never browser input. */
export async function applyVerifiedSubscriptionSnapshot(input: {
  eventId: string
  bodyHash: string
  snapshot: VerifiedSubscriptionSnapshot
  actor?: Actor
  planChange?: VerifiedPlanChange
}) {
  const eventId = z.string().trim().min(1).max(255).parse(input.eventId)
  const bodyHash = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.bodyHash)
  const snapshot = snapshotSchema.parse(input.snapshot)
  const planChange = input.planChange
    ? planChangeSchema.parse(input.planChange)
    : null
  if (planChange && !input.actor) throw new Error("BILLING_ACTOR_REQUIRED")
  if (
    input.actor &&
    workspaceBillingIdentity(input.actor).workspaceId !== snapshot.workspaceId
  )
    throw new Error("BILLING_ACTOR_WORKSPACE_MISMATCH")
  if (
    snapshot.currentPeriodStart >= snapshot.currentPeriodEnd ||
    (snapshot.paidUpgrade &&
      ((snapshot.status !== "active" &&
        !(snapshot.status === "canceled" && snapshot.cancelAtPeriodEnd)) ||
        !!snapshot.terminatedAt ||
        snapshot.plan !== "plus" ||
        snapshot.paidUpgrade.subscriptionId !== snapshot.subscriptionId ||
        snapshot.paidUpgrade.periodStart.getTime() !==
          snapshot.currentPeriodStart.getTime() ||
        snapshot.paidUpgrade.periodEnd.getTime() !==
          snapshot.currentPeriodEnd.getTime() ||
        snapshot.paidUpgrade.createdAt < snapshot.currentPeriodStart ||
        snapshot.paidUpgrade.createdAt >= snapshot.currentPeriodEnd)) ||
    (snapshot.terminatedAt &&
      (snapshot.status !== "canceled" ||
        snapshot.terminatedAt > snapshot.updatedAt)) ||
    (snapshot.status === "canceled" &&
      !snapshot.cancelAtPeriodEnd &&
      !snapshot.terminatedAt) ||
    (snapshot.status === "past_due" &&
      (!snapshot.pastDueAt || snapshot.pastDueAt > snapshot.updatedAt))
  ) {
    throw new Error("BILLING_SNAPSHOT_INVALID")
  }
  // Keep unchanged pre-expansion snapshots replayable without a version conflict.
  const {
    cancelAtPeriodEnd: cancelFlag,
    terminatedAt,
    paidUpgrade,
    ...legacySnapshot
  } = snapshot
  const cancellationSnapshot = cancelFlag
    ? { ...legacySnapshot, cancelAtPeriodEnd: true }
    : legacySnapshot
  const stateHash = createHash("sha256")
    .update(
      JSON.stringify(
        terminatedAt
          ? { ...cancellationSnapshot, terminatedAt }
          : cancellationSnapshot
      )
    )
    .digest("hex")
  return db.transaction(async (tx) => {
    // Lock the existing workspace even before its first entitlement row exists.
    // This serializes receipt, first activation and failure-episode updates.
    const workspace = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, snapshot.workspaceId))
      .for("update")
    if (!workspace.length) throw new Error("BILLING_WORKSPACE_NOT_FOUND")
    if (input.actor) {
      const membership = await tx.query.members.findFirst({
        where: (t, ops) =>
          ops.and(
            ops.eq(t.organizationId, snapshot.workspaceId),
            ops.eq(t.userId, input.actor!.userId)
          ),
      })
      if (
        !membership ||
        !hasWorkspaceRole({ ...input.actor, workspaceRole: membership.role }, [
          "owner",
          "admin",
        ])
      )
        throw new Error("BILLING_ACTOR_REVOKED")
    }
    const duplicate = await tx.query.billingEventReceipts.findFirst({
      where: and(
        eq(billingEventReceipts.environment, snapshot.environment),
        eq(billingEventReceipts.eventId, eventId)
      ),
    })
    if (duplicate) {
      if (
        duplicate.bodyHash !== bodyHash ||
        duplicate.workspaceId !== snapshot.workspaceId ||
        duplicate.subscriptionId !== snapshot.subscriptionId
      )
        throw new Error("BILLING_EVENT_CONFLICT")
    }
    const previous = await tx.query.workspaceEntitlements.findFirst({
      where: eq(workspaceEntitlements.workspaceId, snapshot.workspaceId),
    })
    const sameSubscription =
      previous?.source === "polar" &&
      previous.sourceReference === snapshot.subscriptionId &&
      previous.providerEnvironment === snapshot.environment
    if (previous?.source === "polar" && !sameSubscription)
      throw new Error("BILLING_SUBSCRIPTION_CONFLICT")
    let projectedAccess: ReturnType<typeof subscriptionAccess> | undefined
    async function currentAccess() {
      if (!projectedAccess) {
        const state = await tx.query.workspaceEntitlements.findFirst({
          where: eq(workspaceEntitlements.workspaceId, snapshot.workspaceId),
        })
        projectedAccess = subscriptionAccess(state)
      }
      return projectedAccess
    }
    async function answer(outcome: string, replayed: boolean) {
      return { outcome, replayed, effectivePlan: (await currentAccess()).plan }
    }
    async function receipt(outcome: "applied" | "stale" | "unchanged") {
      if (duplicate)
        await tx
          .update(billingEventReceipts)
          .set({ outcome })
          .where(
            and(
              eq(billingEventReceipts.environment, snapshot.environment),
              eq(billingEventReceipts.eventId, eventId)
            )
          )
      else
        await tx.insert(billingEventReceipts).values({
          workspaceId: snapshot.workspaceId,
          environment: snapshot.environment,
          eventId,
          bodyHash,
          subscriptionId: snapshot.subscriptionId,
          outcome,
        })
      return answer(outcome, !!duplicate)
    }
    if (terminatedAt) {
      // Final provider revocation is restrictive independently of ordinary state
      // ordering. It can also promote a previously acknowledged active event.
      const earlier = sameSubscription ? previous.terminatedAt : null
      const cutoff = new Date(
        Math.min(earlier?.getTime() ?? Infinity, terminatedAt.getTime())
      )
      const changed = !earlier || cutoff < earlier
      if (!changed && duplicate) return answer(duplicate.outcome, true)
      if (changed) {
        if (sameSubscription)
          await tx
            .update(workspaceEntitlements)
            .set({ terminatedAt: cutoff, updatedAt: new Date() })
            .where(eq(workspaceEntitlements.workspaceId, snapshot.workspaceId))
        else {
          const terminalBinding = {
            plan: snapshot.plan === "starter" ? "basic" : "business",
            status: "canceled",
            source: "polar",
            sourceReference: snapshot.subscriptionId,
            providerEnvironment: snapshot.environment,
            providerUpdatedAt: snapshot.updatedAt,
            providerStateHash: stateHash,
            currentPeriodStart: snapshot.currentPeriodStart,
            currentPeriodEnd: snapshot.currentPeriodEnd,
            terminatedAt: cutoff,
            cancelAtPeriodEnd: false,
            cancellationPeriodEnd: null,
            paidActivatedAt: null,
            paymentFailedAt: null,
            graceExpiresAt: null,
            updatedAt: new Date(),
          }
          await tx
            .insert(workspaceEntitlements)
            .values({ workspaceId: snapshot.workspaceId, ...terminalBinding })
            .onConflictDoUpdate({
              target: workspaceEntitlements.workspaceId,
              set: terminalBinding,
            })
        }
        await tx.insert(workspaceSecurityAuditEvents).values({
          workspaceId: snapshot.workspaceId,
          actorUserId: input.actor?.userId ?? null,
          action: "billing.subscription.terminated",
          target: snapshot.subscriptionId,
          outcome: "succeeded",
          after: {
            terminatedAt: cutoff.toISOString(),
            normalizedStatus: snapshot.status,
          },
          requestId: eventId,
        })
      }
      return receipt(changed ? "applied" : "unchanged")
    }
    const usablePaidUpgrade =
      paidUpgrade &&
      !previous?.refundedPeriods.some(
        (period) =>
          period.kind === "upgrade" &&
          period.environment === snapshot.environment &&
          period.orderId === paidUpgrade.orderId
      )
        ? paidUpgrade
        : undefined
    const paymentPromotion =
      sameSubscription &&
      !previous.terminatedAt &&
      previous.plan === "basic" &&
      snapshot.plan === "plus" &&
      (snapshot.status === "active" ||
        (snapshot.status === "canceled" && snapshot.cancelAtPeriodEnd)) &&
      !!usablePaidUpgrade
    if (duplicate && !paymentPromotion) return answer(duplicate.outcome, true)
    // This subscription is terminal. Only a separately verified replacement
    // binding can establish new paid access; ordinary snapshots never clear it.
    if (sameSubscription && previous.terminatedAt) return receipt("unchanged")
    let outcome: "applied" | "stale" | "unchanged" = "applied"
    if (sameSubscription && previous.providerUpdatedAt) {
      const version =
        snapshot.updatedAt.getTime() - previous.providerUpdatedAt.getTime()
      if (version < 0) outcome = "stale"
      if (version === 0) {
        const legacyHash = createHash("sha256")
          .update(JSON.stringify(legacySnapshot))
          .digest("hex")
        const restrictiveExpansion =
          cancelFlag &&
          !previous.cancelAtPeriodEnd &&
          !previous.cancellationPeriodEnd &&
          previous.providerStateHash === legacyHash
        if (previous.providerStateHash !== stateHash && !restrictiveExpansion)
          throw new Error("BILLING_VERSION_CONFLICT")
        outcome =
          restrictiveExpansion || paymentPromotion ? "applied" : "unchanged"
      }
    }
    if (outcome === "applied") {
      // A refunded term is no longer paid proof for a subsequent failed renewal.
      // Clear it durably so repeated past-due snapshots cannot restart access.
      const invalidatedPaidProof =
        sameSubscription &&
        snapshot.status === "past_due" &&
        isRefundedSubscriptionPeriod(previous)
      const paidActivatedAt =
        sameSubscription && !invalidatedPaidProof
          ? previous.paidActivatedAt
          : null
      const status =
        snapshot.status === "canceled" &&
        sameSubscription &&
        previous.status === "past_due"
          ? "past_due"
          : snapshot.status
      const candidateFailure =
        snapshot.status === "canceled" && sameSubscription
          ? previous.paymentFailedAt
          : snapshot.pastDueAt
      const earlierFailure =
        sameSubscription && previous.status === "past_due"
          ? previous.paymentFailedAt
          : null
      // A renewal may keep the earliest failure, never move it later on retries.
      const failure =
        earlierFailure && candidateFailure
          ? new Date(
              Math.min(earlierFailure.getTime(), candidateFailure.getTime())
            )
          : candidateFailure
      const eligibleForGrace =
        status === "past_due" &&
        paidActivatedAt &&
        failure &&
        paidActivatedAt < failure
      const cancelAtPeriodEnd =
        snapshot.cancelAtPeriodEnd || snapshot.status === "canceled"
      const previousEnd = sameSubscription
        ? previous.cancellationPeriodEnd
        : null
      const cancellationPeriodEnd = cancelAtPeriodEnd
        ? new Date(
            Math.min(
              previousEnd?.getTime() ?? Infinity,
              snapshot.currentPeriodEnd.getTime()
            )
          )
        : null
      const values = {
        plan: snapshot.plan === "starter" ? "basic" : "business",
        status,
        source: "polar",
        sourceReference: snapshot.subscriptionId,
        providerEnvironment: snapshot.environment,
        providerUpdatedAt: snapshot.updatedAt,
        providerStateHash: stateHash,
        currentPeriodStart: snapshot.currentPeriodStart,
        currentPeriodEnd: snapshot.currentPeriodEnd,
        cancelAtPeriodEnd,
        cancellationPeriodEnd,
        paidActivatedAt:
          snapshot.status === "active"
            ? (paidActivatedAt ?? snapshot.updatedAt)
            : paidActivatedAt,
        paymentFailedAt: eligibleForGrace ? failure : null,
        graceExpiresAt: eligibleForGrace
          ? new Date(failure.getTime() + PAYMENT_GRACE_MS)
          : null,
        updatedAt: new Date(),
      }
      const unpaidUpgrade =
        sameSubscription &&
        previous.plan === "basic" &&
        snapshot.plan === "plus" &&
        !usablePaidUpgrade
      const earlyDowngrade =
        sameSubscription &&
        previous.plan === "business" &&
        snapshot.plan === "starter" &&
        previous.currentPeriodEnd &&
        snapshot.currentPeriodStart < previous.currentPeriodEnd
      if (unpaidUpgrade || earlyDowngrade) {
        // Preserve the paid contract and its clocks; provider product/status alone
        // cannot authorize an unpaid upgrade or an early loss of purchased Plus.
        Object.assign(values, {
          plan: previous.plan,
          status: previous.status,
          paidActivatedAt: previous.paidActivatedAt,
          currentPeriodStart: previous.currentPeriodStart,
          currentPeriodEnd: previous.currentPeriodEnd,
          cancelAtPeriodEnd: previous.cancelAtPeriodEnd,
          cancellationPeriodEnd: previous.cancellationPeriodEnd,
          paymentFailedAt: previous.paymentFailedAt,
          graceExpiresAt: previous.graceExpiresAt,
        })
      }
      const paidUpgradeOrderId =
        values.plan === "business"
          ? (usablePaidUpgrade?.orderId ??
            (sameSubscription ? previous.paidUpgradeOrderId : null))
          : null
      await tx
        .insert(workspaceEntitlements)
        .values({
          workspaceId: snapshot.workspaceId,
          ...values,
          paidUpgradeOrderId,
        })
        .onConflictDoUpdate({
          target: workspaceEntitlements.workspaceId,
          set: { ...values, paidUpgradeOrderId },
        })
      await tx.insert(workspaceSecurityAuditEvents).values({
        workspaceId: snapshot.workspaceId,
        actorUserId: input.actor?.userId ?? null,
        action: "billing.entitlements.reconciled",
        target: snapshot.subscriptionId,
        outcome: "succeeded",
        after: {
          plan: values.plan,
          status: values.status,
          providerStatus: snapshot.status,
          upgradePaymentPending: unpaidUpgrade,
          earlyDowngradeDeferred: !!earlyDowngrade,
          paidUpgradeOrderId,
          cancellationPeriodEnd:
            values.cancellationPeriodEnd?.toISOString() ?? null,
          graceExpiresAt: values.graceExpiresAt?.toISOString() ?? null,
        },
        requestId: eventId,
      })
    }
    if (planChange && outcome !== "stale") {
      const pending =
        planChange.target === "plus" &&
        (await currentAccess()).plan !== "business"
      await tx.insert(workspaceSecurityAuditEvents).values({
        workspaceId: snapshot.workspaceId,
        actorUserId: input.actor!.userId,
        action: "billing.plan_change.confirmed",
        target: snapshot.subscriptionId,
        outcome: "succeeded",
        after: {
          ...planChange,
          status: pending ? "payment-pending" : planChange.status,
          effectiveAt: pending
            ? null
            : (planChange.effectiveAt?.toISOString() ?? null),
        },
        requestId: eventId,
      })
    }
    return receipt(outcome)
  })
}
