import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SecuritySettings } from "./security-settings"

vi.mock("@tanstack/react-router", async () => {
  const React = await import("react")

  return {
    Link: React.forwardRef<
      HTMLAnchorElement,
      React.ComponentProps<"a"> & { to: string }
    >(function MockLink({ to, ...props }, ref) {
      return <a ref={ref} href={to} {...props} />
    }),
  }
})

describe("SecuritySettings", () => {
  afterEach(cleanup)

  beforeEach(() => {
    window.localStorage.clear()
  })

  it("renders plan gates as billing buttons", () => {
    render(<SecuritySettings />)

    expect(
      screen.getByRole("heading", { level: 1, name: "Security" })
    ).toBeTruthy()
    expect(screen.getByText("Workspace access")).toBeTruthy()
    expect(screen.getByText("Workspace management")).toBeTruthy()
    expect(screen.getByText("Integrations & applications")).toBeTruthy()
    expect(screen.getByText("MCP Servers")).toBeTruthy()
    const enterpriseButtons = screen.getAllByRole("button", {
      name: "Available on Enterprise",
    })
    const basicButtons = screen.getAllByRole("button", {
      name: "Available on Basic",
    })
    const businessButtons = screen.getAllByRole("button", {
      name: "Available on Business",
    })

    expect(enterpriseButtons).toHaveLength(5)
    expect(basicButtons).toHaveLength(2)
    expect(businessButtons).toHaveLength(4)

    for (const button of [
      ...enterpriseButtons,
      ...basicButtons,
      ...businessButtons,
    ]) {
      expect(button.getAttribute("href")).toBe("/settings/billing")
    }
  })

  it("persists toggle changes", async () => {
    render(<SecuritySettings />)

    const inviteLinks = screen.getByRole("switch", {
      name: "Enable invite links",
    })
    expect(inviteLinks.getAttribute("aria-checked")).toBe("true")

    fireEvent.click(inviteLinks)

    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem("forge:workspace-security") ?? "{}"
      ) as { preferences?: { inviteLinks?: boolean } }
      expect(stored.preferences?.inviteLinks).toBe(false)
    })
  })

  it("adds an approved email domain", async () => {
    render(<SecuritySettings />)

    fireEvent.click(
      screen.getByRole("button", { name: "Add approved email domain" })
    )
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Email domain" }),
      {
        target: { value: "example.com" },
      }
    )
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }))

    expect(await screen.findByText("2 approved email domains")).toBeTruthy()
    expect(screen.getByText("example.com")).toBeTruthy()
  })
})
