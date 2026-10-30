import { useState } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IssueCyclePicker } from "./issue-cycle-picker"
import { IssueComposer } from "./issue-composer"
import type { ReactNode } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import { productStorage } from "@/lib/product-storage"
import {
  initialTeamCycles,
  scheduledTeamCycles,
  teamCyclesStorageKey,
} from "@/lib/team-cycles"
import { blankIssueDraft, readIssueStore } from "@/lib/team-issues"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: "user", name: "Matthieu" } } }),
  },
}))
vi.mock("@/components/team-sidebar-icon", () => ({
  TeamSidebarIcon: () => <span />,
}))
const team = {
  id: "cycle-team",
  name: "Cycle team",
  slug: "cycle-team",
  identifier: "CYC",
} as TeamSummary
const other = { ...team, id: "other", name: "Other team", slug: "other" }
const settings = { ...initialTeamCycles(), enabled: true }
const first = () => scheduledTeamCycles(settings)[0].value
function configure(id: string, enabled: boolean) {
  productStorage.setItem(
    teamCyclesStorageKey(id),
    JSON.stringify({ ...settings, enabled })
  )
  window.dispatchEvent(
    new CustomEvent("forge:team-cycles-changed", {
      detail: teamCyclesStorageKey(id),
    })
  )
}
beforeEach(() => {
  productStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function Picker() {
  const [value, setValue] = useState(first())
  return (
    <IssueCyclePicker
      teamId={team.id}
      property
      value={value}
      onChange={setValue}
    />
  )
}
function Composer({ switchable = false }: { switchable?: boolean }) {
  return (
    <IssueComposer
      team={team}
      directory={
        switchable
          ? {
              teams: [team, other],
              members: [],
              templates: [],
              canManage: false,
              defaults: { members: null, nonMembers: null },
            }
          : undefined
      }
      initial={{ ...blankIssueDraft(), title: "Plan cycle work" }}
      labels={[]}
      projects={[]}
      onClose={vi.fn()}
      onSaved={vi.fn()}
      onDraftSaved={vi.fn()}
    />
  )
}

describe("Issue cycle properties", () => {
  it("shows the issue property only for the enabled team and preserves assignments through toggling", () => {
    configure("other", true)
    render(<Picker />)
    expect(screen.queryByRole("button", { name: "Change cycle" })).toBeNull()
    act(() => configure(team.id, true))
    expect(
      screen.getByRole("button", { name: "Change cycle" }).textContent
    ).toContain("Cycle 1")
    act(() => configure(team.id, false))
    expect(screen.queryByRole("button", { name: "Change cycle" })).toBeNull()
    act(() => configure(team.id, true))
    expect(
      screen.getByRole("button", { name: "Change cycle" }).textContent
    ).toContain("Cycle 1")
    fireEvent.click(screen.getByRole("button", { name: "Change cycle" }))
    fireEvent.click(screen.getByRole("option", { name: "No cycle" }))
    expect(screen.getByRole("button", { name: "Add to cycle" })).toBeTruthy()
  })
  it("adds the selected cycle when creating an issue", () => {
    configure(team.id, true)
    render(<Composer />)
    fireEvent.click(screen.getByRole("button", { name: "Add to cycle" }))
    fireEvent.click(screen.getByRole("option", { name: /Cycle 1 · Upcoming/ }))
    fireEvent.click(screen.getByRole("button", { name: "Create issue" }))
    expect(readIssueStore(team.id).issues[0].cycle).toBe(first())
  })
  it("clears the cycle when switching to a team with cycles disabled", () => {
    configure(team.id, true)
    render(<Composer switchable />)
    fireEvent.click(screen.getByRole("button", { name: "Add to cycle" }))
    fireEvent.click(screen.getByRole("option", { name: /Cycle 1 · Upcoming/ }))
    fireEvent.click(screen.getByRole("button", { name: "Set team" }))
    fireEvent.click(screen.getByRole("option", { name: "Other team" }))
    expect(screen.queryByRole("button", { name: "Change cycle" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Create issue" }))
    expect(readIssueStore(other.id).issues[0].cycle).toBe("")
  })
  it("fails closed for malformed cycle settings without overwriting them", () => {
    productStorage.setItem(teamCyclesStorageKey(team.id), "broken")
    render(<Picker />)
    expect(screen.queryByRole("button", { name: "Change cycle" })).toBeNull()
    expect(productStorage.getItem(teamCyclesStorageKey(team.id))).toBe("broken")
  })
})
