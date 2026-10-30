import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { BillingSettings } from "./billing-settings"

describe("BillingSettings", () => {
  afterEach(cleanup)

  it("shows the server plan, agreed prices, and unavailable financial state", () => {
    render(
      <BillingSettings
        snapshot={{
          plan: "free",
          phase: "free",
          activeMembers: 3,
          trialExpiresAt: null,
        }}
      />
    )

    expect(screen.getByRole("heading", { name: "Billing" })).toBeTruthy()
    expect(screen.getByText("Free plan")).toBeTruthy()
    expect(screen.getByText("Current")).toBeTruthy()
    expect(screen.getByText("3")).toBeTruthy()
    expect(screen.queryByText("$0.00 remaining")).toBeNull()
    expect(screen.getByText("Starter plan")).toBeTruthy()
    expect(
      screen.getByText("€10 / $10 per member/month, before tax")
    ).toBeTruthy()
    expect(screen.getByText("AI usage and credits")).toBeTruthy()
    expect(
      screen.getByText("Invoice history is not available yet.")
    ).toBeTruthy()
  })

  it("renders the complete Starter plan feature set", () => {
    render(
      <BillingSettings
        snapshot={{
          plan: "free",
          phase: "free",
          activeMembers: 3,
          trialExpiresAt: null,
        }}
      />
    )

    expect(screen.getAllByText("5 teams")).not.toHaveLength(0)
    expect(screen.getAllByText("Unlimited file upload size")).not.toHaveLength(
      0
    )
    expect(
      screen.getAllByText("Restrict agent invocation to full workspace members")
    ).not.toHaveLength(0)
  })

  it("opens the plan management menu and upgrade dialog", async () => {
    render(
      <BillingSettings
        snapshot={{
          plan: "free",
          phase: "free",
          activeMembers: 3,
          trialExpiresAt: null,
        }}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Manage" }))

    expect(
      await screen.findByRole("menuitem", { name: "View plan details" })
    ).toBeTruthy()
  })
  it("shows the locked trial tier and original expiry", () => {
    render(
      <BillingSettings
        snapshot={{
          plan: "business",
          phase: "trial",
          activeMembers: 12,
          trialExpiresAt: "2026-11-12T11:00:00Z",
        }}
      />
    )
    expect(screen.getByText("Plus plan")).toBeTruthy()
    expect(screen.getByText("Trial")).toBeTruthy()
    expect(screen.getByText(/Trial ends .*Upgrade manually/)).toBeTruthy()
    expect(screen.getByText("12")).toBeTruthy()
  })
  it("does not assume a Free plan or invent balances when data is unavailable", () => {
    render(<BillingSettings />)
    expect(screen.getByText("Plan unavailable")).toBeTruthy()
    expect(screen.queryByText("Free plan")).toBeNull()
    expect(screen.getByText("Balance unavailable")).toBeTruthy()
  })
  it("keeps checkout disabled and explains trial availability", async () => {
    render(<BillingSettings />)
    fireEvent.click(screen.getByRole("button", { name: "All plans" }))
    const checkout = await screen.findByRole("button", {
      name: "Checkout not available yet",
    })
    expect((checkout as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/workspaces that have never paid/)).toBeTruthy()
    expect(screen.queryByText(/upgrade request is ready/)).toBeNull()
  })
  it("renders the server's lifecycle notice and exact boundary", () => {
    render(
      <BillingSettings
        snapshot={{
          plan: "basic",
          phase: "paid",
          activeMembers: 7,
          trialExpiresAt: null,
          notices: [
            {
              code: "cancellation",
              message:
                "Existing members and files remain accessible after cancellation.",
              effectiveAt: "2026-11-29T12:00:00.000Z",
            },
          ],
        }}
      />
    )
    expect(
      screen.getByText(
        "Existing members and files remain accessible after cancellation."
      )
    ).toBeTruthy()
    const boundary = screen.getByText("2026-11-29 12:00:00 UTC")
    expect(boundary.getAttribute("datetime")).toBe("2026-11-29T12:00:00.000Z")
  })
})
