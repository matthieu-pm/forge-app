import "@tanstack/react-start/server-only"
import { eq, sql } from "drizzle-orm"
import { z } from "zod"
import { db, workspaceEntitlements } from "@/db"

const date = z.coerce.date().nullable().optional()
const stateSchema = z.object({
  plan: z.string(),
  status: z.string(),
  source: z.string().optional(),
  source_reference: z.string().nullable().optional(),
  trial_redemption_id: z.uuid().nullable().optional(),
  provider_environment: z.string().nullable().optional(),
  refunded_periods: z
    .array(
      z.object({
        orderId: z.uuid(),
        subscriptionId: z.uuid(),
        environment: z.enum(["sandbox", "production"]),
        start: z.iso.datetime({ offset: true }),
        end: z.iso.datetime({ offset: true }),
        refundedAt: z.iso.datetime({ offset: true }),
        kind: z.literal("upgrade").optional(),
        starterOrderId: z.uuid().nullable().optional(),
        basePeriodStart: z.iso.datetime({ offset: true }).optional(),
        basePeriodEnd: z.iso.datetime({ offset: true }).optional(),
      })
    )
    .default([]),
  paid_upgrade_order_id: z.uuid().nullable().optional(),
  terminated_at: date,
  unsupported_pause_at: date,
  paid_activated_at: date,
  payment_failed_at: date,
  grace_expires_at: date,
  current_period_start: date,
  current_period_end: date,
  cancel_at_period_end: z.boolean().optional(),
  cancellation_period_end: date,
  feature_overrides: z.record(z.string(), z.boolean()).default({}),
})

/** Whole-row JSON tolerates the pre-expansion table without selecting absent columns. */
export async function readSubscriptionAccessState(workspaceId: string) {
  const rows = await db
    .select({ state: sql<unknown>`to_jsonb(${workspaceEntitlements})` })
    .from(workspaceEntitlements)
    .where(eq(workspaceEntitlements.workspaceId, workspaceId))
    .limit(1)
  const parsed = stateSchema.safeParse(rows[0]?.state)
  if (!parsed.success) return null
  const row = parsed.data
  return {
    plan: row.plan,
    status: row.status,
    source: row.source,
    sourceReference: row.source_reference,
    trialRedemptionId: row.trial_redemption_id,
    providerEnvironment: row.provider_environment,
    refundedPeriods: row.refunded_periods,
    paidUpgradeOrderId: row.paid_upgrade_order_id,
    terminatedAt: row.terminated_at,
    unsupportedPauseAt: row.unsupported_pause_at,
    paidActivatedAt: row.paid_activated_at,
    paymentFailedAt: row.payment_failed_at,
    graceExpiresAt: row.grace_expires_at,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    cancellationPeriodEnd: row.cancellation_period_end,
    featureOverrides: row.feature_overrides,
  }
}
