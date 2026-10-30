import { z } from "zod"

export const selfServePlanSchema = z.enum(["starter", "plus"])
export const standardPlanSchema = z.enum(["free", "starter", "plus"])
export const billingPlanSchema = z.enum([
  "free",
  "starter",
  "plus",
  "enterprise",
])
export type StandardPlan = z.infer<typeof standardPlanSchema>
export type BillingPlan = z.infer<typeof billingPlanSchema>
export const workspaceAccessPhaseSchema = z.enum(["standard", "trial"])
export type WorkspaceAccessPhase = z.infer<typeof workspaceAccessPhaseSchema>
export const billingCurrencySchema = z.enum(["eur", "usd"])
export type SelfServePlan = z.infer<typeof selfServePlanSchema>
export type BillingCurrency = z.infer<typeof billingCurrencySchema>

export const FREE_WORKSPACE_MEMBER_LIMIT = 5
export const STANDARD_PLAN_TRIAL_DAYS = 14

/** Commercial allocation, separate from release gates and operational limits. */
export const planResourceLimits = Object.freeze({
  free: Object.freeze({
    members: FREE_WORKSPACE_MEMBER_LIMIT,
    teams: 2,
    activeIssues: 250,
    uploadBytes: 10_000_000,
  }),
  starter: Object.freeze({
    members: null,
    teams: 5,
    activeIssues: null,
    uploadBytes: null,
  }),
  plus: Object.freeze({
    members: null,
    teams: null,
    activeIssues: null,
    uploadBytes: null,
  }),
  enterprise: Object.freeze({
    members: null,
    teams: null,
    activeIssues: null,
    uploadBytes: null,
  }),
})

/** Only for new uploads/finalization. Never apply the new plan's size cap to reads. */
export function newUploadPlanAdmission(plan: BillingPlan, sizeBytes: number) {
  const selectedPlan = billingPlanSchema.parse(plan)
  const size = z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .parse(sizeBytes)
  const limit = planResourceLimits[selectedPlan].uploadBytes
  return { allowed: limit === null || size <= limit, limitBytes: limit }
}

/** Evaluate under the membership transaction/lock, including batch additions. */
export function workspaceMemberCapacity(
  plan: BillingPlan,
  currentMembers: number,
  additionalMembers = 1
) {
  const selectedPlan = billingPlanSchema.parse(plan)
  const current = z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .parse(currentMembers)
  const additional = billableMemberCountSchema.parse(additionalMembers)
  const projectedMembers = current + additional
  if (!Number.isSafeInteger(projectedMembers))
    throw new Error("Workspace member count exceeds the supported range.")
  const memberLimit = planResourceLimits[selectedPlan].members
  return {
    allowed: memberLimit === null || projectedMembers <= memberLimit,
    memberLimit,
    projectedMembers,
  }
}

// User-confirmed monthly price per user; Enterprise requires a custom agreement.
export const monthlySeatPriceMinor = Object.freeze({
  starter: 1000,
  plus: 1600,
})
export const billableMemberCountSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)

export function monthlyWorkspacePrice(plan: SelfServePlan, members: number) {
  const price = monthlySeatPriceMinor[selfServePlanSchema.parse(plan)]
  const total = price * billableMemberCountSchema.parse(members)
  if (!Number.isSafeInteger(total))
    throw new Error("Workspace price exceeds the supported range.")
  return total
}

/** Quantity is server-resolved; concrete AI allowance lives in workspace-ai-budget. */
export function pooledWorkspaceLimit(perMemberLimit: number, members: number) {
  if (!Number.isSafeInteger(perMemberLimit) || perMemberLimit < 0) {
    throw new Error("The per-member limit must be a nonnegative safe integer.")
  }
  const total = perMemberLimit * billableMemberCountSchema.parse(members)
  if (!Number.isSafeInteger(total))
    throw new Error("Workspace usage limit exceeds the supported range.")
  return total
}
