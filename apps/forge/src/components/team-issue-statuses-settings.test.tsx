import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TeamIssueStatusesSettings } from "./team-issue-statuses-settings"
import type { ReactNode } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import {
  initialTeamStatuses,
  parseTeamStatuses,
  teamStatusesStorageKey,
} from "@/lib/team-statuses"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
const team = {
  id: "test-team",
  slug: "forge",
  name: "Forge",
  icon: { kind: "emoji", value: "🔥", color: "#94a3b8" },
} as TeamSummary
const key = teamStatusesStorageKey(team.id)
const saved = () => parseTeamStatuses(localStorage.getItem(key)!)
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(cleanup)
function create(name: string) {
  fireEvent.click(
    screen.getByRole("button", { name: "Create status in Backlog" })
  )
  fireEvent.change(screen.getByRole("textbox", { name: "Status name" }), {
    target: { value: name },
  })
  fireEvent.click(screen.getByRole("button", { name: "Create" }))
}
describe("team issue statuses", () => {
  it("creates a trimmed status, validates duplicate names, cancels without saving, and restores after remount", () => {
    const view = render(<TeamIssueStatusesSettings team={team} />)
    create("  Ready  ")
    expect(
      saved().statuses.find((status) => status.name === "Ready")?.group
    ).toBe("backlog")
    create("ready")
    expect(screen.getByRole("alert").textContent).toContain("already exists")
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Status name" }), {
      key: "Escape",
    })
    expect(screen.queryByRole("textbox", { name: "Status name" })).toBeNull()
    expect(saved().statuses).toHaveLength(8)
    view.unmount()
    render(<TeamIssueStatusesSettings team={team} />)
    expect(screen.getByText("Ready")).toBeTruthy()
  })
  it("changes defaults and prevents deletion of the default or the last status in a group", async () => {
    render(<TeamIssueStatusesSettings team={team} />)
    fireEvent.click(screen.getByRole("button", { name: "Options for Todo" }))
    const menu = await screen.findByRole("menuitem", { name: "Delete" })
    expect(menu.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(screen.getByRole("menuitem", { name: "Make default" }))
    await waitFor(() => expect(saved().defaultId).toBe("todo"))
    expect(screen.getByText("Todo").textContent).toContain("Default")
  })
  it("preserves corrupt storage and disables changes", () => {
    localStorage.setItem(key, "invalid data")
    render(<TeamIssueStatusesSettings team={team} />)
    expect(screen.getByRole("alert").textContent).toContain("preserved")
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Create status in Backlog",
      }).disabled
    ).toBe(true)
    expect(localStorage.getItem(key)).toBe("invalid data")
  })
  it("keeps the draft when storage fails and isolates teams", () => {
    const view = render(<TeamIssueStatusesSettings team={team} />)
    create("Ready")
    view.unmount()
    render(<TeamIssueStatusesSettings team={{ ...team, id: "another-team" }} />)
    expect(screen.queryByText("Ready")).toBeNull()
    const fail = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota")
      })
    create("Waiting")
    expect(screen.getByRole("alert").textContent).toContain(
      "could not be saved"
    )
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Status name" })
        .value
    ).toBe("Waiting")
    fail.mockRestore()
  })
  it("rejects persisted workflows with missing groups or an invalid default", () => {
    const data = initialTeamStatuses()
    expect(() =>
      parseTeamStatuses(JSON.stringify({ ...data, defaultId: "missing" }))
    ).toThrow()
    expect(() =>
      parseTeamStatuses(
        JSON.stringify({ ...data, statuses: data.statuses.slice(1) })
      )
    ).toThrow()
  })
})
