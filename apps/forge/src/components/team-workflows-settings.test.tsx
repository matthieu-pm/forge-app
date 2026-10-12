import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TeamWorkflowsSettings } from "./team-workflows-settings"
import type { ReactNode } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import {
  initialTeamStatuses,
  teamStatusesStorageKey,
} from "@/lib/team-statuses"
import {
  initialTeamWorkflows,
  parseTeamWorkflows,
  teamWorkflowsStorageKey,
} from "@/lib/team-workflows"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
const team = {
  id: "workflow-test",
  slug: "forge",
  name: "Forge",
  icon: { kind: "emoji", value: "🔥", color: "#94a3b8" },
} as TeamSummary
const key = teamWorkflowsStorageKey(team.id)
const saved = () => parseTeamWorkflows(localStorage.getItem(key)!)
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
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)
function addBranch(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Add branch" }))
  expect(screen.queryByRole("dialog")).toBeNull()
  fireEvent.change(screen.getByRole("textbox", { name: "Branch pattern" }), {
    target: { value: name },
  })
  fireEvent.click(screen.getByRole("button", { name: "Submit" }))
}
describe("team workflows", () => {
  it("persists toggles and restores dependent controls after reload without affecting another team", () => {
    const view = render(<TeamWorkflowsSettings team={team} />)
    fireEvent.click(
      screen.getByRole("switch", { name: "Auto-close parent issues" })
    )
    fireEvent.click(
      screen.getByRole("switch", { name: "Auto-close stale issues" })
    )
    expect(saved()).toMatchObject({
      closeParents: true,
      closeStale: false,
      staleMonths: "6",
    })
    expect(
      screen.queryByRole("combobox", { name: "Close after being stale for" })
    ).toBeNull()
    view.unmount()
    const restored = render(<TeamWorkflowsSettings team={team} />)
    expect(
      screen
        .getByRole("switch", { name: "Auto-close parent issues" })
        .getAttribute("aria-checked")
    ).toBe("true")
    fireEvent.click(
      screen.getByRole("switch", { name: "Auto-close stale issues" })
    )
    expect(
      screen.getByRole("combobox", { name: "Close after being stale for" })
        .textContent
    ).toContain("6 months")
    restored.unmount()
    render(<TeamWorkflowsSettings team={{ ...team, id: "other-team" }} />)
    expect(
      screen
        .getByRole("switch", { name: "Auto-close parent issues" })
        .getAttribute("aria-checked")
    ).toBe("false")
  })
  it("creates branch overrides from current rules and rejects duplicate branches", () => {
    render(<TeamWorkflowsSettings team={team} />)
    addBranch("  release/next  ")
    expect(saved().branches[0]).toMatchObject({
      name: "release/next",
      rules: saved().pullRequests,
    })
    addBranch("release/next")
    expect(screen.getByRole("alert").textContent).toContain("already exist")
    expect(saved().branches).toHaveLength(1)
  })
  it("validates regex patterns, saves the matching mode, and restores it when editing", () => {
    const view = render(<TeamWorkflowsSettings team={team} />)
    fireEvent.click(screen.getByRole("button", { name: "Add branch" }))
    const input = screen.getByRole("textbox", { name: "Branch pattern" })
    expect(document.activeElement).toBe(input)
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Add branch" })
        .disabled
    ).toBe(true)
    fireEvent.click(screen.getByRole("checkbox", { name: "Use regex" }))
    fireEvent.change(input, { target: { value: "[" } })
    fireEvent.click(screen.getByRole("button", { name: "Submit" }))
    expect(screen.getByRole("alert").textContent).toContain(
      "valid regular expression"
    )
    expect(localStorage.getItem(key)).toBeNull()
    fireEvent.change(input, { target: { value: "^release/.*$" } })
    fireEvent.submit(screen.getByRole("form", { name: "Add branch pattern" }))
    expect(saved().branches[0]).toMatchObject({
      name: "^release/.*$",
      useRegex: true,
    })
    view.unmount()
    render(<TeamWorkflowsSettings team={team} />)
    fireEvent.click(screen.getByRole("button", { name: "Rename ^release/.*$" }))
    expect(
      screen
        .getByRole("checkbox", { name: "Use regex" })
        .getAttribute("aria-checked")
    ).toBe("true")
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Branch pattern" }), {
      key: "Escape",
    })
    expect(screen.queryByRole("textbox", { name: "Branch pattern" })).toBeNull()
    expect(saved().branches).toHaveLength(1)
  })
  it("cancels an inline draft without saving and reads older literal branches", () => {
    const old = {
      ...initialTeamWorkflows(),
      branches: [
        { id: "old", name: "main", rules: initialTeamWorkflows().pullRequests },
      ],
    }
    localStorage.setItem(key, JSON.stringify(old))
    render(<TeamWorkflowsSettings team={team} />)
    expect(saved().branches[0].useRegex).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Add branch" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Branch pattern" }), {
      target: { value: "discard" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.queryByRole("textbox", { name: "Branch pattern" })).toBeNull()
    expect(saved().branches).toHaveLength(1)
  })
  it("uses renamed team statuses and shows removed selections explicitly", () => {
    const statuses = initialTeamStatuses()
    statuses.statuses.find((status) => status.id === "in-progress")!.name =
      "Building"
    localStorage.setItem(
      teamStatusesStorageKey(team.id),
      JSON.stringify(statuses)
    )
    const workflows = initialTeamWorkflows()
    workflows.pullRequests.review = "removed-status"
    localStorage.setItem(key, JSON.stringify(workflows))
    render(<TeamWorkflowsSettings team={team} />)
    expect(
      screen.getByRole("combobox", { name: "On PR open, move to..." })
        .textContent
    ).toContain("Building")
    expect(
      screen.getByRole("combobox", {
        name: "On PR review request or activity, move to...",
      }).textContent
    ).toContain("Status unavailable")
  })
  it("preserves malformed storage and disables editing", () => {
    localStorage.setItem(key, "broken")
    render(<TeamWorkflowsSettings team={team} />)
    expect(screen.getByRole("alert").textContent).toContain("preserved")
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Add branch" })
        .disabled
    ).toBe(true)
    expect(localStorage.getItem(key)).toBe("broken")
  })
  it("keeps the previous setting when persistence fails", () => {
    render(<TeamWorkflowsSettings team={team} />)
    const fail = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota")
      })
    const toggle = screen.getByRole("switch", {
      name: "Auto-close parent issues",
    })
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    fail.mockRestore()
  })
})
