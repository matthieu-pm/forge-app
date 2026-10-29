function valid(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error("BILLING_ANCHOR_INVALID")
  return value
}

/** Preserve UTC time and the original day through clamped short months. */
export function nextAnchoredMonth(boundary: Date, anchorDay: number) {
  valid(boundary)
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31)
    throw new Error("BILLING_ANCHOR_INVALID")
  const next = new Date(boundary)
  next.setUTCDate(1)
  next.setUTCMonth(next.getUTCMonth() + 1)
  const last = new Date(next)
  last.setUTCMonth(last.getUTCMonth() + 1)
  last.setUTCDate(0)
  next.setUTCDate(Math.min(anchorDay, last.getUTCDate()))
  return valid(next)
}

/** Adjacent authoritative monthly boundaries recover the unclamped anchor. */
export function captureMonthlyBillingAnchor(start: Date, end: Date) {
  valid(start)
  valid(end)
  const anchorDay = Math.max(start.getUTCDate(), end.getUTCDate())
  if (
    start >= end ||
    nextAnchoredMonth(start, anchorDay).getTime() !== end.getTime()
  )
    throw new Error("BILLING_ANCHOR_RECONCILIATION_REQUIRED")
  return {
    originalPeriodStart: start,
    effectiveAt: end,
    anchorDay,
    nextRenewalAt: nextAnchoredMonth(end, anchorDay),
  }
}

/** Pure schedule, never payment proof or authority to grant an allowance. */
export function replacementAnniversarySchedule(input: {
  originalPeriodStart: Date
  effectiveAt: Date
  anchorDay: number
  nextRenewalAt: Date
  checkoutGraceEndsAt: Date
  paidAt: Date
}) {
  const original = captureMonthlyBillingAnchor(
    input.originalPeriodStart,
    input.effectiveAt
  )
  const paidAt = valid(input.paidAt)
  if (
    original.anchorDay !== input.anchorDay ||
    original.nextRenewalAt.getTime() !== valid(input.nextRenewalAt).getTime() ||
    valid(input.checkoutGraceEndsAt).getTime() !==
      input.effectiveAt.getTime() + 168 * 3_600_000
  )
    throw new Error("BILLING_ANCHOR_RECONCILIATION_REQUIRED")
  if (paidAt < input.effectiveAt || paidAt >= input.checkoutGraceEndsAt)
    throw new Error("BILLING_REPLACEMENT_OUTSIDE_CHECKOUT_GRACE")
  const next = nextAnchoredMonth(input.nextRenewalAt, input.anchorDay)
  // Polar's billing-period PATCH sets its private anchor day to the supplied
  // end date. Retain the original day and compare the *following* full instant;
  // equal days alone miss a late checkout's time-of-day drift.
  const providerFollowingEnd = nextAnchoredMonth(
    input.nextRenewalAt,
    input.nextRenewalAt.getUTCDate()
  )
  return {
    usagePeriodStart: input.effectiveAt.toISOString(),
    usagePeriodEnd: input.nextRenewalAt.toISOString(),
    paidAt: paidAt.toISOString(),
    originalAnchorDay: input.anchorDay,
    alignedPeriodEnd: input.nextRenewalAt.toISOString(),
    followingPeriodEnd: next.toISOString(),
    followUpRequired: providerFollowingEnd.getTime() !== next.getTime(),
    grantsFreshPaidPool: false as const,
  }
}
