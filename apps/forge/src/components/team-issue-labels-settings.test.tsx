import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { TeamIssueLabelsSettings } from "./team-issue-labels-settings"
import type { MouseEvent, ReactNode } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import {
  parseTeamLabels,
  projectLabelsStorageKey,
  teamLabelsStorageKey,
  workspaceLabelsStorageKey,
} from "@/lib/team-labels"

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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Element.prototype.scrollIntoView = vi.fn()
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
        name: "Edit description for Launch",
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

describe("saved team label rows", () => {
  it("edits saved names and descriptions inline, retaining usage metadata after remount", () => {
    const view = render(<TeamIssueLabelsSettings team={team} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Edit label name Desktop" })
    )
    const name = screen.getByRole("textbox", { name: "Label name" })
    expect(screen.queryByRole("dialog")).toBeNull()
    fireEvent.change(name, { target: { value: "Desktop app" } })
    fireEvent.keyDown(name, { key: "Enter" })
    fireEvent.click(
      screen.getByRole("button", { name: "Edit description for Desktop app" })
    )
    const description = screen.getByRole("textbox", {
      name: "Label description",
    })
    fireEvent.change(description, {
      target: { value: "Native desktop integrations" },
    })
    fireEvent.blur(description)
    expect(savedLabels().find((label) => label.id === "desktop")).toMatchObject(
      {
        name: "Desktop app",
        description: "Native desktop integrations",
        issues: 4,
        lastApplied: "2026-07-23T12:00:00Z",
        createdAt: "2026-07-23T12:00:00Z",
      }
    )
    view.unmount()
    render(<TeamIssueLabelsSettings team={team} />)
    expect(
      screen.getByRole("button", { name: "Edit label name Desktop app" })
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Actions for Desktop app" })
    ).toBeTruthy()
    expect(
      screen.getByRole("checkbox", { name: "Select label Desktop app" })
    ).toBeTruthy()
  })

  it("uses the dot solely as a color picker without entering a name editor or selecting the row", () => {
    render(<TeamIssueLabelsSettings team={team} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Change color for Desktop" })
    )
    expect(screen.queryByRole("textbox", { name: "Label name" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Green" }))
    expect(savedLabels().find((label) => label.id === "desktop")?.color).toBe(
      "#4cb782"
    )
    expect(
      screen
        .getByRole("checkbox", { name: "Select label Desktop" })
        .getAttribute("aria-checked")
    ).toBe("false")
  })

  it("cancels edits on saved rows without deleting the row or persisting changes", () => {
    render(<TeamIssueLabelsSettings team={team} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Edit label name Desktop" })
    )
    const name = screen.getByRole("textbox", { name: "Label name" })
    fireEvent.change(name, { target: { value: "Cancel me" } })
    fireEvent.keyDown(name, { key: "Escape" })
    expect(
      screen.getByRole("button", { name: "Edit label name Desktop" })
    ).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Edit description for Desktop" })
    )
    const description = screen.getByRole("textbox", {
      name: "Label description",
    })
    fireEvent.change(description, {
      target: { value: "Cancelled description" },
    })
    fireEvent.keyDown(description, { key: "Escape" })
    expect(
      screen.getByRole("button", { name: "Edit description for Desktop" })
        .textContent
    ).toBe("Electron desktop application behavior and native integrations.")
    expect(window.localStorage.getItem(storageKey)).toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: "Edit label name Desktop" })
    )
    const next = screen.getByRole("textbox", { name: "Label name" })
    fireEvent.change(next, { target: { value: "Desktop app" } })
    fireEvent.keyDown(next, { key: "Enter" })
    expect(savedLabels().find((label) => label.id === "desktop")?.name).toBe(
      "Desktop app"
    )
  })

  it("deletes selected labels together and Undo preserves labels created afterward", () => {
    render(<TeamIssueLabelsSettings team={team} />)
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select label Desktop" })
    )
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select label Preferences" })
    )
    expect(screen.getByRole("status").textContent).toBe("2 selected")
    fireEvent.click(
      screen.getByRole("button", { name: "Open label command menu" })
    )
    fireEvent.click(screen.getByRole("option", { name: "Delete labels..." }))
    expect(savedLabels()).toHaveLength(0)
    const options = vi
      .mocked(toast.success)
      .mock.calls.find((call) => call[0] === "2 labels deleted.")![1]!
    const undo = options.action as {
      onClick: (event: MouseEvent<HTMLButtonElement>) => void
    }
    const name = start()
    fireEvent.change(name, { target: { value: "Launch" } })
    fireEvent.keyDown(name, { key: "Enter" })
    act(() => {
      undo.onClick({} as MouseEvent<HTMLButtonElement>)
    })
    expect(
      savedLabels()
        .map((label) => label.name)
        .sort()
    ).toEqual(["Desktop", "Launch", "Preferences"])
  })

  it("exposes inline editing and deletion from each row's action menu", () => {
    render(<TeamIssueLabelsSettings team={team} />)
    fireEvent.click(screen.getByRole("button", { name: "Actions for Desktop" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit label name" }))
    expect(screen.getByRole("textbox", { name: "Label name" })).toBeTruthy()
    expect(screen.queryByRole("dialog")).toBeNull()
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Label name" }), {
      key: "Escape",
    })
    fireEvent.click(screen.getByRole("button", { name: "Actions for Desktop" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }))
    expect(savedLabels().map((label) => label.name)).toEqual(["Preferences"])
  })

  it("retains selected rows when a bulk deletion cannot be saved", async () => {
    render(<TeamIssueLabelsSettings team={team} />)
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select label Desktop" })
    )
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Open label command menu" })
    )
    fireEvent.click(screen.getByRole("option", { name: "Delete labels..." }))
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Search label commands" }),
      { key: "Escape" }
    )
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(
      screen.getByRole("button", { name: "Edit label name Desktop" })
    ).toBeTruthy()
    expect(screen.getByRole("status").textContent).toBe("1 selected")
  })
})

describe("label selection commands", () => {
  function selectBoth() {
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select label Desktop" })
    )
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select label Preferences" })
    )
  }
  function command(name: string) {
    fireEvent.click(
      screen.getByRole("button", { name: "Open label command menu" })
    )
    fireEvent.click(screen.getByRole("option", { name }))
  }

  it("shows a floating bar and all five commands, and filters by search", async () => {
    render(<TeamIssueLabelsSettings team={team} />)
    selectBoth()
    expect(
      screen.getByRole("toolbar", { name: "Selected label actions" })
    ).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Open label command menu" })
    )
    expect(screen.getAllByRole("option")).toHaveLength(5)
    fireEvent.change(
      screen.getByRole("combobox", { name: "Search label commands" }),
      { target: { value: "delete" } }
    )
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1))
    expect(
      screen.getByRole("option", { name: "Delete labels..." })
    ).toBeTruthy()
  })

  it("favorites selected labels and clears selection without changing data", () => {
    render(<TeamIssueLabelsSettings team={team} />)
    selectBoth()
    command("Favorite labels")
    expect(savedLabels().every((label) => label.favorite)).toBe(true)
    expect(screen.getByRole("status").textContent).toBe("2 selected")
    fireEvent.click(screen.getByRole("button", { name: "Clear selected" }))
    expect(screen.queryByRole("toolbar")).toBeNull()
    expect(savedLabels()).toHaveLength(2)
  })

  it("archives selected labels and makes them recoverable from the archived filter", () => {
    render(<TeamIssueLabelsSettings team={team} />)
    selectBoth()
    command("Archive labels...")
    expect(savedLabels().every((label) => label.archived)).toBe(true)
    expect(
      screen.queryByRole("button", { name: "Edit label name Desktop" })
    ).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Filter labels" }))
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "Archived labels" })
    )
    selectBoth()
    command("Unarchive labels...")
    expect(savedLabels().every((label) => !label.archived)).toBe(true)
  })

  it("merges into the chosen label and can undo the merge", () => {
    render(<TeamIssueLabelsSettings team={team} />)
    selectBoth()
    command("Merge labels...")
    fireEvent.click(screen.getByRole("option", { name: "Desktop" }))
    expect(savedLabels()).toHaveLength(1)
    expect(savedLabels()[0]).toMatchObject({ id: "desktop", issues: 21 })
    const options = vi
      .mocked(toast.success)
      .mock.calls.find((call) => call[0] === "Labels merged.")![1]!
    const undo = options.action as {
      onClick: (event: MouseEvent<HTMLButtonElement>) => void
    }
    act(() => undo.onClick({} as MouseEvent<HTMLButtonElement>))
    expect(
      savedLabels()
        .map((label) => label.issues)
        .sort((a, b) => a - b)
    ).toEqual([4, 17])
  })

  it("moves labels to the workspace view and back to the team", () => {
    render(<TeamIssueLabelsSettings team={team} />)
    selectBoth()
    command("Move labels to workspace...")
    expect(savedLabels()).toHaveLength(0)
    expect(
      parseTeamLabels(window.localStorage.getItem(workspaceLabelsStorageKey)!)
        .labels
    ).toHaveLength(2)
    fireEvent.click(
      screen.getByRole("button", { name: "Manage workspace labels" })
    )
    expect(
      screen.getByRole("heading", { name: "Workspace issue labels" })
    ).toBeTruthy()
    selectBoth()
    command("Move labels to team...")
    expect(savedLabels()).toHaveLength(2)
    expect(
      parseTeamLabels(window.localStorage.getItem(workspaceLabelsStorageKey)!)
        .labels
    ).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "Back to team labels" }))
    expect(
      screen.getByRole("button", { name: "Edit label name Desktop" })
    ).toBeTruthy()
  })

  it("rolls back the workspace copy when saving the source fails", async () => {
    render(<TeamIssueLabelsSettings team={team} />)
    selectBoth()
    const original = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value
    ) {
      if (key === storageKey) throw new Error("quota")
      original.call(this, key, value)
    })
    command("Move labels to workspace...")
    expect(window.localStorage.getItem(workspaceLabelsStorageKey)).toBeNull()
    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Search label commands" }),
      { key: "Escape" }
    )
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(
      screen.getByRole("button", { name: "Edit label name Desktop" })
    ).toBeTruthy()
    expect(screen.getByRole("status").textContent).toBe("2 selected")
  })
})

it("keeps the workspace view when undoing an earlier team deletion", () => {
  render(<TeamIssueLabelsSettings team={team} />)
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Select label Desktop" })
  )
  fireEvent.click(
    screen.getByRole("button", { name: "Open label command menu" })
  )
  fireEvent.click(screen.getByRole("option", { name: "Delete labels..." }))
  const options = vi
    .mocked(toast.success)
    .mock.calls.find((call) => call[0] === "Label deleted.")![1]!
  const undo = options.action as {
    onClick: (event: MouseEvent<HTMLButtonElement>) => void
  }
  fireEvent.click(
    screen.getByRole("button", { name: "Manage workspace labels" })
  )
  act(() => undo.onClick({} as MouseEvent<HTMLButtonElement>))
  expect(
    screen.getByRole("heading", { name: "Workspace issue labels" })
  ).toBeTruthy()
  expect(
    screen.queryByRole("button", { name: "Edit label name Desktop" })
  ).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Back to team labels" }))
  expect(
    screen.getByRole("button", { name: "Edit label name Desktop" })
  ).toBeTruthy()
})

describe("workspace label hierarchy", () => {
  it("shows groups and expands or collapses their nested labels", () => {
    render(<TeamIssueLabelsSettings />)
    expect(screen.getByRole("heading", { name: "Issue labels" })).toBeDefined()
    expect(screen.getAllByRole("button", { name: /^Labels in / })).toHaveLength(
      8
    )
    expect(screen.getByRole("columnheader", { name: "Rules" })).toBeDefined()
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse group Direction" })
    )
    expect(
      screen.queryByRole("button", { name: "Edit label name CEO Office" })
    ).toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: "Expand group Direction" })
    )
    expect(
      screen.getByRole("button", { name: "Edit label name CEO Office" })
    ).toBeDefined()
  })

  it("toggles from the group name and row without intercepting selection or editing", async () => {
    render(<TeamIssueLabelsSettings />)
    const name = screen.getByRole("button", { name: "Labels in Direction" })
    fireEvent.click(name)
    expect(name.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(name.closest("tr")!.querySelectorAll("td")[3])
    expect(name.getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select labels in Direction" })
    )
    expect(name.getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(
      screen.getByRole("button", { name: "Edit description for Direction" })
    )
    expect(screen.getByRole("dialog")).toBeDefined()
    expect(name.getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for group Direction" })
    )
    expect(
      await screen.findByRole("menuitem", { name: "Edit group" })
    ).toBeDefined()
    expect(name.getAttribute("aria-expanded")).toBe("true")
  })

  it("searches collapsed groups and reveals matching children", () => {
    render(<TeamIssueLabelsSettings />)
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse group Direction" })
    )
    fireEvent.change(
      screen.getByRole("textbox", { name: "Filter labels by name" }),
      { target: { value: "CEO" } }
    )
    expect(
      screen.getByRole("button", { name: "Labels in Direction" })
    ).toBeDefined()
    expect(
      screen.getByRole("button", { name: "Edit label name CEO Office" })
    ).toBeDefined()
    expect(screen.queryByRole("button", { name: "Labels in Tech" })).toBeNull()
    fireEvent.change(
      screen.getByRole("textbox", { name: "Filter labels by name" }),
      { target: { value: "Direction" } }
    )
    expect(
      screen.getAllByRole("button", { name: /^Edit label name / })
    ).toHaveLength(4)
    fireEvent.change(
      screen.getByRole("textbox", { name: "Filter labels by name" }),
      { target: { value: "no-match-test" } }
    )
    expect(screen.getByRole("status").textContent).toBe(
      "No labels match your filters."
    )
  })

  it("creates a group and a nested label in the workspace directory", async () => {
    const view = render(<TeamIssueLabelsSettings />)
    fireEvent.click(screen.getByRole("button", { name: /^New group$/ }))
    fireEvent.change(screen.getByRole("textbox", { name: /^Name$/ }), {
      target: { value: "Launch" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create group" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for group Launch" })
    )
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "New label in group" })
    )
    const input = screen.getByRole("textbox", { name: "Label name" })
    fireEvent.change(input, { target: { value: "Release" } })
    fireEvent.keyDown(input, { key: "Enter" })
    const stored = parseTeamLabels(
      localStorage.getItem(workspaceLabelsStorageKey)!
    )
    expect(
      stored.labels.find((label) => label.name === "Release")?.groupId
    ).toBe(stored.groups.find((group) => group.name === "Launch")?.id)
    expect(localStorage.getItem(storageKey)).toBeNull()
    view.unmount()
    render(<TeamIssueLabelsSettings />)
    fireEvent.click(screen.getByRole("button", { name: "Expand group Launch" }))
    expect(
      screen.getByRole("button", { name: "Edit label name Release" })
    ).toBeDefined()
  })

  it("selects a group's labels and leaves saved empty workspace data empty", () => {
    const view = render(<TeamIssueLabelsSettings />)
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select labels in Direction" })
    )
    expect(
      screen
        .getByRole("checkbox", { name: "Select label CEO Office" })
        .getAttribute("aria-checked")
    ).toBe("true")
    expect(
      screen.getByRole("toolbar", { name: "Selected label actions" })
    ).toBeDefined()
    view.unmount()
    localStorage.setItem(
      workspaceLabelsStorageKey,
      JSON.stringify({ version: 1, groups: [], labels: [], inheritedCount: 0 })
    )
    render(<TeamIssueLabelsSettings />)
    expect(screen.getByRole("status").textContent).toContain(
      "No workspace labels yet"
    )
    expect(
      screen.queryByRole("button", { name: "Labels in Direction" })
    ).toBeNull()
  })
})

describe("project labels using shared label controls", () => {
  it("renders the project reference groups and persists edits without changing issue labels", async () => {
    const issueData = JSON.stringify({
      version: 1,
      labels: [],
      groups: [],
      inheritedCount: 0,
    })
    localStorage.setItem(workspaceLabelsStorageKey, issueData)
    const view = render(<TeamIssueLabelsSettings entity="project" />)
    expect(
      screen.getByRole("heading", { name: "Project labels" })
    ).toBeDefined()
    expect(screen.getByRole("columnheader", { name: "Projects" })).toBeDefined()
    expect(screen.queryByRole("columnheader", { name: "Issues" })).toBeNull()
    expect(
      screen.getAllByRole("button", { name: /^Expand group / })
    ).toHaveLength(6)
    fireEvent.click(screen.getByRole("button", { name: "New group" }))
    fireEvent.change(screen.getByRole("textbox", { name: /^Name$/ }), {
      target: { value: "Roadmap" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create group" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for group Roadmap" })
    )
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "New label in group" })
    )
    const input = screen.getByRole("textbox", { name: "Label name" })
    fireEvent.change(input, { target: { value: "Next quarter" } })
    fireEvent.keyDown(input, { key: "Enter" })
    const saved = parseTeamLabels(
      localStorage.getItem(projectLabelsStorageKey)!
    )
    expect(saved.labels[0].groupId).toBe(
      saved.groups.find((group) => group.name === "Roadmap")?.id
    )
    expect(localStorage.getItem(workspaceLabelsStorageKey)).toBe(issueData)
    view.unmount()
    render(<TeamIssueLabelsSettings entity="project" />)
    fireEvent.click(
      screen.getByRole("button", { name: "Expand group Roadmap" })
    )
    expect(
      screen.getByRole("button", { name: "Edit label name Next quarter" })
    ).toBeDefined()
  })
})

it("starts initiative labels empty and saves without changing issue or project labels", () => {
  const initiativeKey = "forge:workspace-initiative-labels:v1"
  render(<TeamIssueLabelsSettings entity="initiative" />)
  expect(
    screen.getByRole("heading", { name: "Initiative labels" })
  ).toBeTruthy()
  expect(screen.getByText("No labels found")).toBeTruthy()
  expect(screen.queryByRole("table")).toBeNull()
  const name = start()
  fireEvent.change(name, { target: { value: "Strategic" } })
  fireEvent.keyDown(name, { key: "Enter" })
  expect(
    parseTeamLabels(localStorage.getItem(initiativeKey)!).labels[0].name
  ).toBe("Strategic")
  expect(localStorage.getItem(workspaceLabelsStorageKey)).toBeNull()
  expect(localStorage.getItem(projectLabelsStorageKey)).toBeNull()
  expect(screen.queryByText("No labels found")).toBeNull()
})
