import { z } from "zod"
import { STANDARD_PLAN_TRIAL_DAYS } from "./billing-plan-contract"
import { workspaceUsagePeriod } from "./workspace-usage-period"

const micros = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** Ledger integration contract: a capacity shadow, never a second invoice/grant. */
export function trialExpiryCarryover(input: {
  workspaceId: string
  redemptionId: string
  workspaceCreatedAt: Date
  trialStartedAt: Date
  now: Date
  settledTrialMicros: number
  reservedTrialMicros: number
}) {
  const redemptionId = z.uuid().parse(input.redemptionId)
  const expiresAt = new Date(
    input.trialStartedAt.getTime() + STANDARD_PLAN_TRIAL_DAYS * 86400000
  )
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    input.trialStartedAt < input.workspaceCreatedAt ||
    !Number.isFinite(input.now.getTime()) ||
    input.now < expiresAt
  )
    throw new Error("TRIAL_CARRYOVER_NOT_DUE")
  const target = workspaceUsagePeriod(input.workspaceId, expiresAt, {
    kind: "free",
    workspaceCreatedAt: input.workspaceCreatedAt,
  })
  const current = workspaceUsagePeriod(input.workspaceId, input.now, {
    kind: "free",
    workspaceCreatedAt: input.workspaceCreatedAt,
  })
  const settled = micros.parse(input.settledTrialMicros),
    reserved = micros.parse(input.reservedTrialMicros)
  const committed = micros.parse(settled + reserved)
  return {
    key: JSON.stringify([
      "forge.trial-expiry-capacity",
      input.workspaceId,
      redemptionId,
      target.key,
    ]),
    targetPeriod: target,
    // Late delivery cannot move trial consumption to a later anniversary.
    appliesToCurrentFreePeriod: target.key === current.key,
    settledCapacityMicros: settled,
    reservedCapacityMicros: reserved,
    committedCapacityMicros: committed,
    newAllowanceMicros: 0 as const,
    billableMicros: 0 as const,
  }
}
