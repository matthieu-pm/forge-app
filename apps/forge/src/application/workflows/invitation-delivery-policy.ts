export type InvitationDeliveryEffect = "initial" | "reminder-24h"

const MINIMUM_REMINDER_WINDOW_MS = 15 * 60 * 1_000

export function invitationEffectKey(
  invitationId: string,
  effect: InvitationDeliveryEffect
) {
  return `workspace-invitation:${invitationId}:${effect}:v1`
}

export function classifyInvitationDelivery(input: {
  effect: InvitationDeliveryEffect
  expiresAt: Date
  now: Date
  status: string
}) {
  if (input.status !== "pending") return "not-pending" as const

  const remainingMs = input.expiresAt.getTime() - input.now.getTime()
  if (remainingMs <= 0) return "expired" as const
  if (
    input.effect === "reminder-24h" &&
    remainingMs < MINIMUM_REMINDER_WINDOW_MS
  ) {
    return "too-close-to-expiry" as const
  }

  return "deliver" as const
}
