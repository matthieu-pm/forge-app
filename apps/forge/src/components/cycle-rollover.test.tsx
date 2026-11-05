import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TeamCyclesSettings } from "./team-cycles-settings"
import { TeamCycles } from "./team-cycles"
import type * as TeamCyclesModule from "@/lib/team-cycles"
import type { TeamSummary } from "@/lib/team-contract"
import { initialTeamCycles } from "@/lib/team-cycles-contract"

const fixture = vi.hoisted(() => ({
  rolloverAvailable: true,
  canManage: true,
  carryover: true,
  update: vi.fn(async () => true),
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))
vi.mock("@/lib/team-cycles", async (original) => ({
  ...(await original<typeof TeamCyclesModule>()),
  useTeamCycles: () => ({
    settings: {
      ...initialTeamCycles(),
      enabled: true,
      carryover: fixture.carryover,
    },
    ready: true,
    pending: false,
    error: null,
    rolloverAvailable: fixture.rolloverAvailable,
    canManage: fixture.canManage,
    update: fixture.update,
    retry: vi.fn(),
    discard: vi.fn(),
    cycles: [
      {
        id: "c",
        number: 12,
        start: new Date("2026-10-19T12:00:00"),
        end: new Date("2026-11-01T12:00:00"),
        timezone: "Europe/Paris",
        state: "Closed",
        issueCount: 10,
        completedCount: 6,
        closure: { closedAt: "2026-11-02T00:01:00Z", carriedCount: 4 },
      },
    ],
  }),
}))
const team = { id: "t", slug: "forge", name: "Forge" } as TeamSummary
afterEach(() => {
  cleanup()
  fixture.rolloverAvailable = true
  fixture.canManage = true
  fixture.update.mockClear()
})
describe("cycle rollover presentation", () => {
  it("exposes a carryover setting without enabling the separate assignment controls", async () => {
    render(<TeamCyclesSettings team={team} />)
    const toggle = screen.getByRole("switch", {
      name: "Carry unfinished issues forward",
    })
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(toggle)
    expect(fixture.update).toHaveBeenCalledWith({ carryover: false })
    expect(
      screen
        .getByRole("switch", { name: "Started issues" })
        .getAttribute("aria-disabled")
    ).toBe("true")
    expect(
      screen.getByText("Automatic assignment is not available yet.")
    ).toBeTruthy()
  })
  it("hides the setting outside rollout and disables it for members who cannot manage the schedule", () => {
    fixture.rolloverAvailable = false
    const view = render(<TeamCyclesSettings team={team} />)
    expect(
      screen.queryByRole("switch", { name: "Carry unfinished issues forward" })
    ).toBeNull()
    fixture.rolloverAvailable = true
    fixture.canManage = false
    view.rerender(<TeamCyclesSettings team={team} />)
    expect(
      screen
        .getByRole("switch", { name: "Carry unfinished issues forward" })
        .getAttribute("aria-disabled")
    ).toBe("true")
  })
  it("labels closed cycles with frozen completion and carryover totals", () => {
    render(<TeamCycles team={team} />)
    expect(screen.getByText("Closed")).toBeTruthy()
    expect(screen.getByText("6/10 completed · 4 carried")).toBeTruthy()
  })
})
