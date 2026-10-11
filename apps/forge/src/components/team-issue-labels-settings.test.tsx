import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TeamIssueLabelsSettings } from "./team-issue-labels-settings"
import type { ReactNode } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import { parseTeamLabels, teamLabelsStorageKey } from "@/lib/team-labels"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const team: TeamSummary = {
  id: "ed38ea82-49ad-4e50-bac2-e19f674b3e4c",
  slug: "forge",
  identifier: "FOR",
  name: "Forge",
  icon: { kind: "emoji", value: "🔥", color: "#94a3b8" },
  timezone: "Europe/Paris",
  description: "",
  visibility: "workspace",
  estimationScheme: "none",
  issueEmailEnabled: false,
  detailedHistoryEnabled: false,
  createdAt: "2026-10-11T10:00:00Z",
}
const storageKey = teamLabelsStorageKey(team.id)
function savedLabels() {
  return parseTeamLabels(window.localStorage.getItem(storageKey)!).labels
}
function start() {
  fireEvent.click(screen.getByRole("button", { name: "New label" }))
  return screen.getByRole<HTMLInputElement>("textbox", {
    name: "Label name",
  })
}

beforeEach(() => {
  window.localStorage.clear()
})
afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe("inline new team label", () => {
  it("starts one focused draft row without persisting an unnamed label", () => {
    render(<TeamIssueLabelsSettings team={team} />)
    const name = start()
    expect(document.activeElement).toBe(name)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(window.localStorage.getItem(storageKey)).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "New label" }))
    expect(screen.getAllByRole("textbox", { name: "Label name" })).toHaveLength(
      1
    )
    expect(document.activeElement).toBe(name)
  })

  it("saves on Enter and updates the same label when its description blurs", () => {
    render(<TeamIssueLabelsSettings team={team} />)
    const name = start()
    fireEvent.change(name, { target: { value: "  Launch  " } })
    fireEvent.keyDown(name, { key: "Enter" })
    const saved = savedLabels().find((label) => label.name === "Launch")!
    expect(saved).toMatchObject({
      color: "#eb5757",
      description: "",
      issues: 0,
    })
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add label description...",
      })
    )
    const description = screen.getByRole("textbox", {
      name: "Label description",
    })
    fireEvent.change(description, {
      target: { value: "  A planned release  " },
    })
    fireEvent.blur(description)
    expect(
      savedLabels().find((label) => label.id === saved.id)?.description
    ).toBe("A planned release")
    expect(
      savedLabels().filter((label) => label.name === "Launch")
    ).toHaveLength(1)
  })

  it("saves name on blur and leaves a fresh draft after the next New label action", () => {
    render(<TeamIssueLabelsSettings team={team} />)
    const name = start()
    fireEvent.change(name, { target: { value: "Launch" } })
    fireEvent.blur(name)
    expect(savedLabels().some((label) => label.name === "Launch")).toBe(true)
    const next = start()
    expect(next.value).toBe("")
    expect(
      savedLabels().filter((label) => label.name === "Launch")
    ).toHaveLength(1)
  })

  it("rejects duplicate names without losing the draft", () => {
    render(<TeamIssueLabelsSettings team={team} />)
    const name = start()
    fireEvent.change(name, { target: { value: "DESKTOP" } })
    fireEvent.keyDown(name, { key: "Enter" })
    expect(screen.getByRole("alert").textContent).toBe(
      "A label with this name already exists."
    )
    expect(name.value).toBe("DESKTOP")
    expect(window.localStorage.getItem(storageKey)).toBeNull()
  })

  it("discards an unsaved row with Escape and restores focus to New label", () => {
    render(<TeamIssueLabelsSettings team={team} />)
    const name = start()
    fireEvent.change(name, { target: { value: "Discard me" } })
    fireEvent.keyDown(name, { key: "Escape" })
    expect(screen.queryByRole("textbox", { name: "Label name" })).toBeNull()
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "New label" })
    )
    expect(window.localStorage.getItem(storageKey)).toBeNull()
  })

  it("keeps the entered name when browser storage rejects a save", () => {
    render(<TeamIssueLabelsSettings team={team} />)
    const name = start()
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    fireEvent.change(name, { target: { value: "Keep me" } })
    fireEvent.keyDown(name, { key: "Enter" })
    expect(screen.getByRole("alert").textContent).toBe(
      "Could not save. Please try again."
    )
    expect(name.value).toBe("Keep me")
  })
})
