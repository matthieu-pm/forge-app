import { subscriptionAccess } from "./subscription-access"
import type { SubscriptionAccessState } from "./subscription-access"

export type BillingNotice = {
  code:
    | "trial"
    | "payment-grace"
    | "cancellation"
    | "provider-pause"
    | "free-capacity"
  message: string
  effectiveAt: string | null
}

function timestamp(value: Date | null | undefined) {
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString()
    : null
}

/** Read-only communications from the same server-time access decision as enforcement. */
export function workspaceBillingNotices(
  state: SubscriptionAccessState | null | undefined,
  activeMembers: number,
  now = new Date()
): Array<BillingNotice> {
  const access = subscriptionAccess(state, now)
  const notices: Array<BillingNotice> = []
  if (access.phase === "trial") {
    notices.push({
      code: "trial",
      message:
        "Your trial ends at the time shown. Upgrade manually to keep paid features. You will not be charged automatically. The trial's US$5 AI pool does not refill; consumed and reserved usage count against Free allowance when it ends.",
      effectiveAt: timestamp(state?.currentPeriodEnd),
    })
  }
  if (access.phase === "grace") {
    notices.push({
      code: "payment-grace",
      message:
        "Renewal payment failed. Payment grace ends at the time shown; cancellation or a provider restriction can end access sooner. Pay before then to keep paid features. Included AI and any previously authorized capped overage remain available during grace.",
      effectiveAt: timestamp(state?.graceExpiresAt),
    })
  }
  if (access.phase !== "free" && state?.cancelAtPeriodEnd) {
    notices.push({
      code: "cancellation",
      message:
        "Cancellation is scheduled. Paid access ends at the time shown, or earlier if payment grace expires or a provider restriction takes effect. Your workspace then uses Free limits; existing members and files remain accessible.",
      effectiveAt: timestamp(state.cancellationPeriodEnd),
    })
  }
  if (access.phase !== "free" && state?.unsupportedPauseAt) {
    notices.push({
      code: "provider-pause",
      message:
        "A provider pause is scheduled. Paid access ends at the time shown. Contact billing support to resolve it; existing members and files remain accessible under Free limits.",
      effectiveAt: timestamp(state.unsupportedPauseAt),
    })
  }
  if (access.phase === "free") {
    notices.push({
      code: "free-capacity",
      message:
        activeMembers >= 5
          ? "Existing members and files remain accessible. New members can join when fewer than 5 members are active. Free allows 2 teams, 250 active issues and new uploads up to 10 MB; existing content is kept when above a limit. Paid overage is unavailable."
          : "Free allows 5 members, 2 teams, 250 active issues and new uploads up to 10 MB. Existing content is kept when above a limit. The shared monthly AI allowance is US$5; paid overage is unavailable.",
      effectiveAt: null,
    })
  }
  return notices
}
