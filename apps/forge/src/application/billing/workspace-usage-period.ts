import { STANDARD_PLAN_TRIAL_DAYS } from "./billing-plan-contract"

export type WorkspaceUsagePeriod = {
  workspaceId: string
  key: string
  start: Date
  end: Date
}

export type WorkspacePeriodSource =
  | { kind: "free"; workspaceCreatedAt: Date }
  | { kind: "trial"; trialStartedAt: Date }
  | { kind: "paid-monthly"; currentPeriodStart: Date; currentPeriodEnd: Date }

function timestamp(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("A valid workspace usage-period timestamp is required.")
  }
  return value.getTime()
}

/** Clamp short months from the ORIGINAL anchor, restoring the day next month. */
function anniversary(anchor: Date, monthOffset: number) {
  const date = new Date(anchor)
  date.setUTCDate(1)
  date.setUTCMonth(anchor.getUTCMonth() + monthOffset)
  const lastDay = new Date(date)
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1)
  lastDay.setUTCDate(0)
  date.setUTCDate(Math.min(anchor.getUTCDate(), lastDay.getUTCDate()))
  timestamp(date)
  return date
}

/** Half-open [start, end); paid boundaries come from reconciled provider state. */
export function workspaceUsagePeriod(
  workspaceId: string,
  now: Date,
  source: WorkspacePeriodSource
): WorkspaceUsagePeriod {
  if (!workspaceId.trim()) throw new Error("Workspace identity is required.")
  const at = timestamp(now)
  let start: Date
  let end: Date
  if (source.kind === "trial") {
    start = new Date(timestamp(source.trialStartedAt))
    end = new Date(
      timestamp(start) + STANDARD_PLAN_TRIAL_DAYS * 24 * 60 * 60 * 1000
    )
    timestamp(end)
    if (at < start.getTime() || at >= end.getTime())
      throw new Error(
        "Trial usage must be within its original 14-day window; upgrade manually after expiry."
      )
  } else if (source.kind === "paid-monthly") {
    start = new Date(timestamp(source.currentPeriodStart))
    end = new Date(timestamp(source.currentPeriodEnd))
    if (
      start.getTime() >= end.getTime() ||
      at < start.getTime() ||
      at >= end.getTime()
    ) {
      throw new Error(
        "Refresh the paid workspace's authoritative billing period before admitting usage."
      )
    }
  } else {
    const anchor = source.workspaceCreatedAt
    if (at < timestamp(anchor))
      throw new Error("Usage cannot precede workspace signup.")
    let months =
      (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      now.getUTCMonth() -
      anchor.getUTCMonth()
    if (anniversary(anchor, months).getTime() > at) months -= 1
    start = anniversary(anchor, months)
    end = anniversary(anchor, months + 1)
  }
  return {
    workspaceId,
    start,
    end,
    // The source label is deliberately absent: identical windows cannot mint
    // separate free/paid pools. Plan-change carryover remains a ledger concern.
    key: JSON.stringify([
      "forge.ai-usage-period",
      workspaceId,
      start.toISOString(),
      end.toISOString(),
    ]),
  }
}
