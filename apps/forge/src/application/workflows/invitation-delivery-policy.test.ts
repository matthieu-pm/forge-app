import { describe, expect, it } from "vitest"

import {
  classifyInvitationDelivery,
  invitationEffectKey,
} from "@/application/workflows/invitation-delivery-policy"

const now = new Date("2026-07-26T12:00:00.000Z")

describe("invitation delivery policy", () => {
  it("delivers the initial email for a pending invitation", () => {
    expect(
      classifyInvitationDelivery({
        effect: "initial",
        expiresAt: new Date("2026-07-28T12:00:00.000Z"),
        now,
        status: "pending",
      })
    ).toBe("deliver")
  })

  it.each(["accepted", "rejected", "cancelled", "expired"])(
    "suppresses delivery after the invitation becomes %s",
    (status) => {
      expect(
        classifyInvitationDelivery({
          effect: "reminder-24h",
          expiresAt: new Date("2026-07-28T12:00:00.000Z"),
          now,
          status,
        })
      ).toBe("not-pending")
    }
  )

  it("does not deliver an expired invitation", () => {
    expect(
      classifyInvitationDelivery({
        effect: "initial",
        expiresAt: now,
        now,
        status: "pending",
      })
    ).toBe("expired")
  })

  it("suppresses a late reminder near the 48-hour boundary", () => {
    expect(
      classifyInvitationDelivery({
        effect: "reminder-24h",
        expiresAt: new Date(now.getTime() + 14 * 60 * 1_000),
        now,
        status: "pending",
      })
    ).toBe("too-close-to-expiry")
  })

  it("uses separate domain-stable keys for initial and reminder effects", () => {
    expect(invitationEffectKey("invitation-1", "initial")).toBe(
      "workspace-invitation:invitation-1:initial:v1"
    )
    expect(invitationEffectKey("invitation-1", "reminder-24h")).toBe(
      "workspace-invitation:invitation-1:reminder-24h:v1"
    )
  })
})
