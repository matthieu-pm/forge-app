import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { PAYMENT_GRACE_MS } from "./subscription-access"
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
  status: z.enum(["active", "past_due"]),
  updatedAt: z.date(),
  currentPeriodStart: z.date(),
  currentPeriodEnd: z.date(),
  pastDueAt: z.date().nullable(),
})
export type VerifiedSubscriptionSnapshot = z.infer<typeof snapshotSchema>

/** Server-only sink for provider-verified identity/catalog snapshots, never browser input. */
export async function applyVerifiedSubscriptionSnapshot(input: {
  eventId: string
  bodyHash: string
  snapshot: VerifiedSubscriptionSnapshot
}) {
  const eventId = z.string().trim().min(1).max(255).parse(input.eventId)
  const bodyHash = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.bodyHash)
  const snapshot = snapshotSchema.parse(input.snapshot)
  if (
    snapshot.currentPeriodStart >= snapshot.currentPeriodEnd ||
    (snapshot.status === "past_due" &&
      (!snapshot.pastDueAt || snapshot.pastDueAt > snapshot.updatedAt))
  ) {
    throw new Error("BILLING_SNAPSHOT_INVALID")
  }
  const stateHash = createHash("sha256")
    .update(JSON.stringify(snapshot))
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
        if (previous.providerStateHash !== stateHash)
          throw new Error("BILLING_VERSION_CONFLICT")
        outcome = "unchanged"
      }
    }
    if (outcome === "applied") {
      const paidActivatedAt = sameSubscription ? previous.paidActivatedAt : null
      const candidateFailure = snapshot.pastDueAt
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
        snapshot.status === "past_due" &&
        paidActivatedAt &&
        failure &&
        paidActivatedAt < failure
      const values = {
        plan: snapshot.plan === "starter" ? "basic" : "business",
        status: snapshot.status,
        source: "polar",
        sourceReference: snapshot.subscriptionId,
        providerEnvironment: snapshot.environment,
        providerUpdatedAt: snapshot.updatedAt,
        providerStateHash: stateHash,
        currentPeriodStart: snapshot.currentPeriodStart,
        currentPeriodEnd: snapshot.currentPeriodEnd,
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
        action: "billing.entitlements.reconciled",
        target: snapshot.subscriptionId,
        outcome: "succeeded",
        after: {
          plan: values.plan,
          status: values.status,
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
