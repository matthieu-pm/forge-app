import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import {
  PAYMENT_GRACE_MS,
  isRefundedSubscriptionPeriod,
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
})
export type VerifiedSubscriptionSnapshot = z.input<typeof snapshotSchema>

/** Server-only sink for provider-verified identity/catalog snapshots, never browser input. */
export async function applyVerifiedSubscriptionSnapshot(input: {
  eventId: string
  bodyHash: string
  snapshot: VerifiedSubscriptionSnapshot
  actor?: Actor
}) {
  const eventId = z.string().trim().min(1).max(255).parse(input.eventId)
  const bodyHash = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.bodyHash)
  const snapshot = snapshotSchema.parse(input.snapshot)
  if (
    input.actor &&
    workspaceBillingIdentity(input.actor).workspaceId !== snapshot.workspaceId
  )
    throw new Error("BILLING_ACTOR_WORKSPACE_MISMATCH")
  if (
    snapshot.currentPeriodStart >= snapshot.currentPeriodEnd ||
    (snapshot.status === "canceled" && !snapshot.cancelAtPeriodEnd) ||
    (snapshot.status === "past_due" &&
      (!snapshot.pastDueAt || snapshot.pastDueAt > snapshot.updatedAt))
  ) {
    throw new Error("BILLING_SNAPSHOT_INVALID")
  }
  // Keep unchanged pre-expansion snapshots replayable without a version conflict.
  const { cancelAtPeriodEnd: cancelFlag, ...legacySnapshot } = snapshot
  const stateHash = createHash("sha256")
    .update(
      JSON.stringify(
        cancelFlag
          ? { ...legacySnapshot, cancelAtPeriodEnd: true }
          : legacySnapshot
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
      return { outcome: duplicate.outcome, replayed: true }
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
        outcome = restrictiveExpansion ? "applied" : "unchanged"
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
      await tx
        .insert(workspaceEntitlements)
        .values({ workspaceId: snapshot.workspaceId, ...values })
        .onConflictDoUpdate({
          target: workspaceEntitlements.workspaceId,
          set: values,
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
          cancellationPeriodEnd:
            values.cancellationPeriodEnd?.toISOString() ?? null,
          graceExpiresAt: values.graceExpiresAt?.toISOString() ?? null,
        },
        requestId: eventId,
      })
    }
    await tx.insert(billingEventReceipts).values({
      workspaceId: snapshot.workspaceId,
      environment: snapshot.environment,
      eventId,
      bodyHash,
      subscriptionId: snapshot.subscriptionId,
      outcome,
    })
    return { outcome, replayed: false }
  })
}
