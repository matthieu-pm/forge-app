import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TeamCyclesSettings } from "./team-cycles-settings"
import type { ReactNode } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import {
  nextCycleStart,
  parseTeamCycles,
  teamCyclesStorageKey,
} from "@/lib/team-cycles"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))
const team = {
  id: "cycles-test",
  slug: "forge",
  name: "Forge",
  icon: { kind: "emoji", value: "🔥", color: "#94a3b8" },
} as TeamSummary
const key = teamCyclesStorageKey(team.id)
const saved = () => parseTeamCycles(localStorage.getItem(key)!)
beforeEach(() => {
  localStorage.clear()
})
afterEach(cleanup)
const enable = () => screen.getByRole("switch", { name: "Enable cycles" })
const priority = () => screen.getByRole("switch", { name: "Started issues" })
describe("team cycles settings", () => {
  it("gates automation behind cycles and preserves its choice across disable and reload", () => {
    const view = render(<TeamCyclesSettings team={team} />)
    expect(priority().getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(enable())
    expect(priority().getAttribute("aria-disabled")).not.toBe("true")
    fireEvent.click(priority())
    expect(saved()).toMatchObject({ enabled: true, startedIssues: false })
    fireEvent.click(enable())
    expect(saved()).toMatchObject({ enabled: false, startedIssues: false })
    view.unmount()
    render(<TeamCyclesSettings team={team} />)
    fireEvent.click(enable())
    expect(priority().getAttribute("aria-checked")).toBe("false")
  })
  it("isolates settings per team and preserves corrupt saved data", () => {
    const view = render(<TeamCyclesSettings team={team} />)
    fireEvent.click(enable())
    view.unmount()
    localStorage.setItem(teamCyclesStorageKey("other"), "invalid")
    render(<TeamCyclesSettings team={{ ...team, id: "other" }} />)
    expect(screen.getByRole("alert").textContent).toContain("preserved")
    expect(enable().getAttribute("aria-disabled")).toBe("true")
    expect(localStorage.getItem(teamCyclesStorageKey("other"))).toBe("invalid")
    expect(saved().enabled).toBe(true)
  })
  it("leaves the previous value when saving fails", () => {
    render(<TeamCyclesSettings team={team} />)
    const fail = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota")
      })
    fireEvent.click(enable())
    expect(enable().getAttribute("aria-checked")).toBe("false")
    fail.mockRestore()
  })
})

describe("cycle dates", () => {
  it("chooses the next selected weekday across month and year boundaries", () => {
    expect(nextCycleStart(1, new Date(2026, 9, 12)).getDate()).toBe(19)
    const next = nextCycleStart(1, new Date(2026, 11, 31))
    expect([next.getFullYear(), next.getMonth(), next.getDate()]).toEqual([
      2027, 0, 4,
    ])
  })
})
