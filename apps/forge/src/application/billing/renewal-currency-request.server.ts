import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { workspaceBillingIdentity } from "./billing-authority"
import {
  billingCountrySchema,
  workspaceBillingCurrency,
} from "./billing-country"
import {
  billingCurrencySchema,
  monthlyWorkspacePrice,
  selfServePlanSchema,
} from "./billing-plan-contract"
import { PAYMENT_GRACE_MS, subscriptionAccess } from "./subscription-access"
import { captureMonthlyBillingAnchor } from "./monthly-billing-anchor"
import type { Actor } from "@/application/actor"
import { hasWorkspaceRole } from "@/application/authorization"
import {
  billingEventReceipts,
  db,
  members,
  organizations,
  workspaceCurrencyChangeRequests,
  workspaceEntitlements,
  workspaceMemberCapacity,
  workspaceSecurityAuditEvents,
} from "@/db"

const schema = z.object({
  requestId: z.uuid(),
  workspaceId: z.string().min(1),
  environment: z.enum(["sandbox", "production"]),
  subscriptionId: z.uuid(),
  billingCountry: billingCountrySchema,
  fromCurrency: billingCurrencySchema,
  currentPlan: selfServePlanSchema,
  renewalPlan: selfServePlanSchema,
  periodStart: z.date(),
  periodEnd: z.date(),
  providerUpdatedAt: z.date(),
})
export type VerifiedRenewalCurrencyRequest = z.infer<typeof schema>

/** Only provider-verified billing country/binding may reach this server-only sink. */
export async function recordVerifiedRenewalCurrencyRequest(
  actor: Actor,
  value: VerifiedRenewalCurrencyRequest
) {
  const identity = workspaceBillingIdentity(actor),
    input = schema.parse(value)
  if (identity.workspaceId !== input.workspaceId)
    throw new Error("BILLING_ACTOR_WORKSPACE_MISMATCH")
  if (input.periodStart >= input.periodEnd)
    throw new Error("BILLING_CURRENCY_PERIOD_INVALID")
  const target = workspaceBillingCurrency(input.billingCountry).currency
  const anchor = captureMonthlyBillingAnchor(input.periodStart, input.periodEnd)
  const eventId = `forge.currency-request.${input.requestId}`
  const bodyHash = createHash("sha256")
    .update(
      JSON.stringify({
        ...input,
        actorUserId: actor.userId,
        providerUpdatedAt: undefined,
      })
    )
    .digest("hex")
  return db.transaction(async (tx) => {
    const workspace = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, input.workspaceId))
      .for("update")
    if (!workspace.length) throw new Error("BILLING_WORKSPACE_NOT_FOUND")
    const membership = await tx
      .select({ role: members.role })
      .from(members)
      .where(
        and(
          eq(members.organizationId, input.workspaceId),
          eq(members.userId, actor.userId)
        )
      )
      .for("share")
    const member = membership.at(0)
    if (
      !member ||
      !hasWorkspaceRole({ ...actor, workspaceRole: member.role }, [
        "owner",
        "admin",
      ])
    )
      throw new Error("BILLING_ACTOR_REVOKED")
    const state = await tx.query.workspaceEntitlements.findFirst({
      where: eq(workspaceEntitlements.workspaceId, input.workspaceId),
    })
    const access = subscriptionAccess(state)
    if (
      !state ||
      state.source !== "polar" ||
      state.providerEnvironment !== input.environment ||
      state.sourceReference !== input.subscriptionId ||
      state.unsupportedPauseAt ||
      access.phase !== "paid" ||
      access.plan !==
        (input.currentPlan === "starter" ? "basic" : "business") ||
      state.currentPeriodStart?.getTime() !== input.periodStart.getTime() ||
      state.currentPeriodEnd?.getTime() !== input.periodEnd.getTime() ||
      (state.providerUpdatedAt &&
        state.providerUpdatedAt > input.providerUpdatedAt)
    )
      throw new Error("BILLING_CURRENCY_CONTEXT_CHANGED")
    const priorReceipt = await tx.query.billingEventReceipts.findFirst({
      where: and(
        eq(billingEventReceipts.environment, input.environment),
        eq(billingEventReceipts.eventId, eventId)
      ),
    })
    const answer = (
      row: typeof workspaceCurrencyChangeRequests.$inferSelect,
      replayed: boolean
    ) => ({
      id: row.id,
      status: row.state === "requested" ? "requires-checkout" : row.state,
      fromCurrency: row.fromCurrency,
      targetCurrency: row.targetCurrency,
      billingCountry: row.billingCountry,
      effectiveAt: row.effectiveAt.toISOString(),
      checkoutGraceEndsAt: row.checkoutGraceEndsAt.toISOString(),
      renewalPlan: row.renewalPlan,
      renewalMembers: row.renewalMembers,
      renewalPriceMinor: row.renewalPriceMinor,
      providerChangeScheduled: false as const,
      billingAnchorDay: row.billingAnchorDay,
      nextRenewalAt: row.nextRenewalAt?.toISOString() ?? null,
      replayed,
    })
    if (priorReceipt) {
      if (
        priorReceipt.bodyHash !== bodyHash ||
        priorReceipt.workspaceId !== input.workspaceId ||
        priorReceipt.subscriptionId !== input.subscriptionId
      )
        throw new Error("BILLING_EVENT_CONFLICT")
      const row = await tx.query.workspaceCurrencyChangeRequests.findFirst({
        where: eq(workspaceCurrencyChangeRequests.id, input.requestId),
      })
      if (!row || row.workspaceId !== input.workspaceId)
        throw new Error("BILLING_CURRENCY_RECEIPT_INCOMPLETE")
      // Pre-expansion intents have no recoverable day-of-month in the row.
      // Only the original matching, freshly verified source period may fill it.
      if (row.originalPeriodStart === null) {
        const [captured] = await tx
          .update(workspaceCurrencyChangeRequests)
          .set({
            originalPeriodStart: input.periodStart,
            billingAnchorDay: anchor.anchorDay,
            nextRenewalAt: anchor.nextRenewalAt,
            updatedAt: new Date(),
          })
          .where(eq(workspaceCurrencyChangeRequests.id, row.id))
          .returning()
        await tx.insert(workspaceSecurityAuditEvents).values({
          workspaceId: input.workspaceId,
          actorUserId: actor.userId,
          action: "billing.currency_change.anchor_captured",
          target: row.id,
          outcome: "succeeded",
          requestId: `forge.currency-anchor.${row.id}`,
          after: {
            originalPeriodStart: captured.originalPeriodStart!.toISOString(),
            billingAnchorDay: captured.billingAnchorDay,
            nextRenewalAt: captured.nextRenewalAt!.toISOString(),
          },
        })
        return answer(captured, true)
      }
      if (
        row.originalPeriodStart.getTime() !== input.periodStart.getTime() ||
        row.billingAnchorDay !== anchor.anchorDay ||
        row.nextRenewalAt?.getTime() !== anchor.nextRenewalAt.getTime()
      )
        throw new Error("BILLING_ANCHOR_RECONCILIATION_REQUIRED")
      return answer(row, true)
    }
    const pending = await tx.query.workspaceCurrencyChangeRequests.findFirst({
      where: and(
        eq(workspaceCurrencyChangeRequests.workspaceId, input.workspaceId),
        eq(workspaceCurrencyChangeRequests.state, "requested")
      ),
    })
    if (
      pending &&
      (pending.subscriptionId !== input.subscriptionId ||
        pending.environment !== input.environment ||
        pending.effectiveAt.getTime() !== input.periodEnd.getTime())
    )
      throw new Error("BILLING_CURRENCY_REQUEST_RECONCILIATION_REQUIRED")
    const capacity = await tx.query.workspaceMemberCapacity.findFirst({
      where: eq(workspaceMemberCapacity.workspaceId, input.workspaceId),
    })
    if (!capacity) throw new Error("BILLING_MEMBER_CAPACITY_REQUIRED")
    if (pending)
      await tx
        .update(workspaceCurrencyChangeRequests)
        .set({ state: "superseded", updatedAt: new Date() })
        .where(eq(workspaceCurrencyChangeRequests.id, pending.id))
    const [row] = await tx
      .insert(workspaceCurrencyChangeRequests)
      .values({
        id: input.requestId,
        workspaceId: input.workspaceId,
        actorUserId: actor.userId,
        environment: input.environment,
        subscriptionId: input.subscriptionId,
        billingCountry: input.billingCountry,
        fromCurrency: input.fromCurrency,
        targetCurrency: target,
        currentPlan: input.currentPlan,
        renewalPlan: input.renewalPlan,
        renewalMembers: capacity.activeMemberCount,
        renewalPriceMinor: monthlyWorkspacePrice(
          input.renewalPlan,
          capacity.activeMemberCount
        ),
        effectiveAt: input.periodEnd,
        originalPeriodStart: input.periodStart,
        billingAnchorDay: anchor.anchorDay,
        nextRenewalAt: anchor.nextRenewalAt,
        checkoutGraceEndsAt: new Date(
          input.periodEnd.getTime() + PAYMENT_GRACE_MS
        ),
        state:
          target !== input.fromCurrency
            ? "requested"
            : pending
              ? "withdrawn"
              : "unchanged",
      })
      .returning()
    await tx.insert(workspaceSecurityAuditEvents).values({
      workspaceId: input.workspaceId,
      actorUserId: actor.userId,
      action: "billing.currency_change.requested",
      target: row.id,
      outcome: "succeeded",
      requestId: eventId,
      after: {
        fromCurrency: row.fromCurrency,
        targetCurrency: row.targetCurrency,
        billingCountry: row.billingCountry,
        effectiveAt: row.effectiveAt.toISOString(),
        billingAnchorDay: row.billingAnchorDay,
        nextRenewalAt: row.nextRenewalAt!.toISOString(),
        checkoutGraceEndsAt: row.checkoutGraceEndsAt.toISOString(),
        state: row.state,
        providerChangeScheduled: false,
      },
    })
    await tx.insert(billingEventReceipts).values({
      workspaceId: input.workspaceId,
      environment: input.environment,
      eventId,
      bodyHash,
      subscriptionId: input.subscriptionId,
      outcome: row.state === "unchanged" ? "unchanged" : "applied",
    })
    return answer(row, false)
  })
}
