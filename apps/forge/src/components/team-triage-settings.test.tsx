import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TeamTriageSettings } from "./team-triage-settings"
import type { ReactNode } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import { selectOption } from "@/test-utils/select-option"
import { parseTeamTriage, teamTriageStorageKey } from "@/lib/team-triage"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))
const team = {
  id: "triage-test",
  slug: "forge",
  name: "Forge",
  icon: { kind: "emoji", value: "🔥", color: "#94a3b8" },
} as TeamSummary
const key = teamTriageStorageKey(team.id)
const saved = () => parseTeamTriage(localStorage.getItem(key)!)
beforeEach(() => {
  localStorage.clear()
})
afterEach(cleanup)
const enable = () =>
  screen.getByRole("switch", { name: "Enable triage for this team" })
const priority = () =>
  screen.getByRole("switch", { name: "Require explicit prioritization" })
describe("team triage settings", () => {
  it("gates prioritization behind triage and preserves its choice across disable and reload", () => {
    const view = render(<TeamTriageSettings team={team} />)
    expect(priority().getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(enable())
    expect(priority().getAttribute("aria-disabled")).not.toBe("true")
    fireEvent.click(priority())
    expect(saved()).toEqual({ enabled: true, requirePriority: true })
    fireEvent.click(enable())
    expect(saved()).toEqual({ enabled: false, requirePriority: true })
    view.unmount()
    render(<TeamTriageSettings team={team} />)
    fireEvent.click(enable())
    expect(priority().getAttribute("aria-checked")).toBe("true")
  })
  it("isolates settings per team and preserves corrupt saved data", () => {
    const view = render(<TeamTriageSettings team={team} />)
    fireEvent.click(enable())
    view.unmount()
    localStorage.setItem(teamTriageStorageKey("other"), "invalid")
    render(<TeamTriageSettings team={{ ...team, id: "other" }} />)
    expect(screen.getByRole("alert").textContent).toContain("preserved")
    expect(enable().getAttribute("aria-disabled")).toBe("true")
    expect(localStorage.getItem(teamTriageStorageKey("other"))).toBe("invalid")
    expect(saved().enabled).toBe(true)
  })
  it("leaves the previous value when saving fails", () => {
    render(<TeamTriageSettings team={team} />)
    const fail = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota")
      })
    fireEvent.click(enable())
    expect(enable().getAttribute("aria-checked")).toBe("false")
    fail.mockRestore()
  })
  it("opens the shared responsibility settings when triage is enabled", () => {
    render(<TeamTriageSettings team={team} />)
    fireEvent.click(enable())
    fireEvent.click(screen.getByRole("button", { name: "Configure" }))
    selectOption(screen.getByRole("combobox", { name: "Action" }), "Assign")
    expect(saved().action).toBe("assign")
    expect(screen.getByRole("dialog").textContent).toContain(
      "not connected yet"
    )
  })
})
