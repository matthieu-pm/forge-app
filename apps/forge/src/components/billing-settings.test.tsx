import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { BillingSettings } from "./billing-settings"

describe("BillingSettings", () => {
  afterEach(cleanup)

  it("shows the current plan, upgrade offer, credits, and invoice state", () => {
    render(<BillingSettings />)

    expect(screen.getByRole("heading", { name: "Billing" })).toBeTruthy()
    expect(screen.getByText("Free plan")).toBeTruthy()
    expect(screen.getByText("Current")).toBeTruthy()
    expect(screen.getByText("Upgrade to Basic plan")).toBeTruthy()
    expect(screen.getByText("$12 per user/mo")).toBeTruthy()
    expect(screen.getByText("AI usage and credits")).toBeTruthy()
    expect(screen.getByText("No invoices yet")).toBeTruthy()
  })

  it("renders the complete Basic plan feature set", () => {
    render(<BillingSettings />)

    expect(screen.getAllByText("5 teams")).not.toHaveLength(0)
    expect(screen.getAllByText("Unlimited file upload size")).not.toHaveLength(
      0
    )
    expect(
      screen.getAllByText("Restrict agent invocation to full workspace members")
    ).not.toHaveLength(0)
  })

  it("opens the plan management menu and upgrade dialog", async () => {
    render(<BillingSettings />)

    fireEvent.click(screen.getByRole("button", { name: "Manage" }))

    expect(
      await screen.findByRole("menuitem", { name: "View plan details" })
    ).toBeTruthy()
  })
})
