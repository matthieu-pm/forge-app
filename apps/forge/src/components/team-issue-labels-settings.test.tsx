import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TeamIssueLabelsSettings } from "./team-issue-labels-settings"
import type { ReactNode } from "react"
import { productStorage } from "@/lib/product-storage"
import {
  parseTeamLabels,
  projectLabelsStorageKey,
  workspaceLabelsStorageKey,
} from "@/lib/team-labels"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

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
  productStorage.clear()
})
afterEach(() => {
  cleanup()
  productStorage.clear()
})

describe("project labels using shared label controls", () => {
  it("renders the project reference groups and persists edits without changing issue labels", async () => {
    const issueData = JSON.stringify({
      version: 1,
      labels: [],
      groups: [],
      inheritedCount: 0,
    })
    productStorage.setItem(workspaceLabelsStorageKey, issueData)
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
      productStorage.getItem(projectLabelsStorageKey)!
    )
    expect(saved.labels[0].groupId).toBe(
      saved.groups.find((group) => group.name === "Roadmap")?.id
    )
    expect(productStorage.getItem(workspaceLabelsStorageKey)).toBe(issueData)
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
    parseTeamLabels(productStorage.getItem(initiativeKey)!).labels[0].name
  ).toBe("Strategic")
  expect(productStorage.getItem(workspaceLabelsStorageKey)).toBeNull()
  expect(productStorage.getItem(projectLabelsStorageKey)).toBeNull()
  expect(screen.queryByText("No labels found")).toBeNull()
})
