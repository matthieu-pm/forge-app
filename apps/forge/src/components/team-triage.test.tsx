import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TeamTriage } from "./team-triage"
import { TeamTriageSettings } from "./team-triage-settings"
import type { ReactNode } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import {
  initialTeamTriage,
  teamTriageStorageKey,
  useEnabledTeamTriage,
} from "@/lib/team-triage"
import { parseTriageIssues, triageIssuesKey } from "@/lib/triage-issues"
import { buildYourTeamsNav } from "@/lib/app-navigation"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))
const team = {
  id: "triage-test",
  slug: "product",
  name: "Product",
  identifier: "PRO",
  icon: { kind: "emoji", value: "🔥", color: "#94a3b8" },
} as TeamSummary
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(
    teamTriageStorageKey(team.id),
    JSON.stringify({ ...initialTeamTriage(), enabled: true })
  )
})
afterEach(cleanup)
function create(title: string) {
  fireEvent.click(
    screen.getAllByRole("button", { name: "Create triage issue" })[0]
  )
  fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
    target: { value: title },
  })
  fireEvent.click(screen.getByRole("button", { name: "Create issue" }))
}
function Navigation() {
  const enabled = useEnabledTeamTriage([team.id, "other"])
  const nav = buildYourTeamsNav([
    { ...team, triageEnabled: enabled.has(team.id) },
    { name: "Other", slug: "other", triageEnabled: enabled.has("other") },
  ])
  return (
    <nav>
      {nav
        .flatMap((item) => item.items ?? [])
        .map((item) => (
          <a key={item.to} href={item.to}>
            {item.title}
          </a>
        ))}
    </nav>
  )
}
describe("team triage", () => {
  it("updates navigation immediately from the team settings switch", () => {
    render(
      <>
        <Navigation />
        <TeamTriageSettings team={team} />
      </>
    )
    expect(screen.getAllByRole("link", { name: "Triage" })).toHaveLength(1)
    fireEvent.click(
      screen.getByRole("switch", { name: "Enable triage for this team" })
    )
    expect(screen.queryByRole("link", { name: "Triage" })).toBeNull()
    fireEvent.click(
      screen.getByRole("switch", { name: "Enable triage for this team" })
    )
    expect(
      screen.getByRole("link", { name: "Triage" }).getAttribute("href")
    ).toBe("/teams/product/triage")
  })
  it("creates, edits, persists, and snoozes a team issue", async () => {
    const view = render(<TeamTriage team={team} />)
    create("Investigate request")
    expect(
      screen.getByRole("heading", { name: "Investigate request" })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Edit issue" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "Updated request" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save issue" }))
    view.unmount()
    render(<TeamTriage team={team} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Open PRO-T1 Updated request" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }))
    expect(
      screen.queryByRole("button", { name: "Open PRO-T1 Updated request" })
    ).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Display options" }))
    fireEvent.click(await screen.findByRole("switch", { name: "Show snoozed" }))
    expect(
      screen.getByRole("button", { name: "Open PRO-T1 Updated request" })
    ).toBeTruthy()
    expect(
      parseTriageIssues(localStorage.getItem(triageIssuesKey(team.id))!)[0]
        .snoozed
    ).toBe(true)
  })
  it("gates direct navigation and responds to settings changes", () => {
    render(<TeamTriage team={team} />)
    act(() => {
      localStorage.setItem(
        teamTriageStorageKey(team.id),
        JSON.stringify(initialTeamTriage())
      )
      window.dispatchEvent(
        new StorageEvent("storage", { key: teamTriageStorageKey(team.id) })
      )
    })
    expect(
      screen.getByRole("heading", { name: "Triage is disabled" })
    ).toBeTruthy()
    expect(
      screen.queryByRole("button", { name: "Create triage issue" })
    ).toBeNull()
  })
  it("isolates team issues and preserves corrupted data", () => {
    const view = render(<TeamTriage team={team} />)
    create("Private request")
    view.unmount()
    localStorage.setItem(
      teamTriageStorageKey("other"),
      JSON.stringify({ ...initialTeamTriage(), enabled: true })
    )
    localStorage.setItem(triageIssuesKey("other"), "broken")
    render(<TeamTriage team={{ ...team, id: "other" }} />)
    expect(screen.queryByText("Private request")).toBeNull()
    expect(screen.getByRole("alert").textContent).toContain("preserved")
    expect(localStorage.getItem(triageIssuesKey("other"))).toBe("broken")
  })
  it("retains drafts after a storage failure", () => {
    render(<TeamTriage team={team} />)
    const fail = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota")
      })
    create("Keep my draft")
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "draft is still here"
    )
    expect(
      within(dialog).getByRole<HTMLInputElement>("textbox", {
        name: "Issue title",
      }).value
    ).toBe("Keep my draft")
    fail.mockRestore()
  })
  it("filters by priority without modifying saved issues", async () => {
    render(<TeamTriage team={team} />)
    create("Low urgency")
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }))
    fireEvent.change(
      await screen.findByRole("combobox", { name: "Filter by priority" }),
      { target: { value: "Urgent" } }
    )
    expect(
      screen.queryByRole("button", { name: "Open PRO-T1 Low urgency" })
    ).toBeNull()
    expect(
      parseTriageIssues(localStorage.getItem(triageIssuesKey(team.id))!)
    ).toHaveLength(1)
  })
})
