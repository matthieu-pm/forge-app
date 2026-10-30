import { cleanup, fireEvent, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NotificationPreferencesPage } from "./notifications-settings"
import type { ReactNode } from "react"
import {
  readTestPreferences,
  renderPreferences,
  setupPreferenceFixture,
} from "@/test/preference-fixture"

vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: null }) },
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    disabled,
    ...props
  }: {
    children: ReactNode
    to: string
    params?: { channel: string }
    disabled?: boolean
  }) => (
    <a
      {...props}
      href={
        disabled ? undefined : to.replace("$channel", params?.channel ?? "")
      }
    >
      {children}
    </a>
  ),
}))
beforeEach(async () => {
  localStorage.clear()
  await setupPreferenceFixture()
})
afterEach(cleanup)

describe("notification settings interactions", () => {
  it("enables priority configuration only when the inbox preference is on", () => {
    renderPreferences(<NotificationPreferencesPage userId="test" />)
    const priority = screen.getByText("Priority notifications").closest("a")!
    expect(priority.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(screen.getByRole("switch", { name: "Priority inbox" }))
    expect(priority.getAttribute("aria-disabled")).toBe("false")
    expect(priority.getAttribute("href")).toBe(
      "/settings/notifications/priority"
    )
  })

  it("retains chosen types across disabling and re-enabling a channel", () => {
    const view = renderPreferences(
      <NotificationPreferencesPage userId="test" channel="desktop" />
    )
    fireEvent.click(screen.getByRole("checkbox", { name: "Assignments" }))
    const toggle = screen.getByRole("switch", {
      name: "Enable desktop notifications",
    })
    fireEvent.click(toggle)
    expect(
      screen
        .getByRole("checkbox", { name: "Mentions" })
        .getAttribute("aria-disabled")
    ).toBe("true")
    fireEvent.click(toggle)
    expect(
      screen
        .getByRole("checkbox", { name: "Assignments" })
        .getAttribute("aria-checked")
    ).toBe("false")
    view.unmount()
    renderPreferences(<NotificationPreferencesPage userId="test" />)
    expect(
      screen.getByText("Enabled for status changes, mentions, 11 others")
    ).toBeDefined()
  })

  it("saves update toggles while preserving the other defaults", () => {
    renderPreferences(<NotificationPreferencesPage userId="test" />)
    fireEvent.click(
      screen.getByRole("switch", { name: "Changelog newsletter" })
    )
    const saved = readTestPreferences("test").notifications
    expect(saved.updates).toEqual({
      sidebar: false,
      changelog: true,
      marketing: false,
      invite: true,
      legal: true,
      dpa: false,
    })
  })
})
