import { z } from "zod"
import { workspaceUsagePeriod } from "./workspace-usage-period"

const micros = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** Ending paid customer-pool exposure becomes capacity, never a fresh charge. */
export function paidToFreeCarryover(input: {
  workspaceId: string
  sourcePeriodId: string
  workspaceCreatedAt: Date
  paidAccessEndedAt: Date
  now: Date
  settledPoolUsdMicros: number
  reservedPoolUsdMicros: number
}) {
  const source = z.uuid().parse(input.sourcePeriodId)
  z.date().parse(input.paidAccessEndedAt)
  z.date().parse(input.now)
  if (input.now < input.paidAccessEndedAt)
    throw new Error("USAGE_DOWNGRADE_NOT_DUE")
  const target = workspaceUsagePeriod(
    input.workspaceId,
    input.paidAccessEndedAt,
    { kind: "free", workspaceCreatedAt: input.workspaceCreatedAt }
  )
  const current = workspaceUsagePeriod(input.workspaceId, input.now, {
    kind: "free",
    workspaceCreatedAt: input.workspaceCreatedAt,
  })
  return {
    key: JSON.stringify([
      "forge.paid-to-free-capacity",
      input.workspaceId,
      source,
      target.key,
    ]),
    targetPeriod: target,
    appliesToCurrentFreePeriod: target.key === current.key,
    committedCapacityMicros: micros.parse(
      micros.parse(input.settledPoolUsdMicros) +
        micros.parse(input.reservedPoolUsdMicros)
    ),
    newAllowanceMicros: 0 as const,
    billableMicros: 0 as const,
  }
}
