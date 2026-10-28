import "@tanstack/react-start/server-only"
import { eq, sql } from "drizzle-orm"
import { z } from "zod"
import { db, workspaceEntitlements } from "@/db"

const date = z.coerce.date().nullable().optional()
const stateSchema = z.object({
  plan: z.string(),
  status: z.string(),
  source: z.string().optional(),
  paid_activated_at: date,
  payment_failed_at: date,
  grace_expires_at: date,
  current_period_start: date,
  current_period_end: date,
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
    paidActivatedAt: row.paid_activated_at,
    paymentFailedAt: row.payment_failed_at,
    graceExpiresAt: row.grace_expires_at,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    featureOverrides: row.feature_overrides,
  }
}
