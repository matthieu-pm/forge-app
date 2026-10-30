import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IssueDefinitionProvider } from "./issue-definition-provider"
import { TeamIssueStatusesSettings } from "./team-issue-statuses-settings"
import { TeamIssueLabelsSettings } from "./team-issue-labels-settings"
import { Properties } from "./templates/template-controls"
import { TeamWorkflowsSettings } from "./team-workflows-settings"
import type { TeamSummary } from "@/lib/team-contract"
import type { DefinitionSnapshot } from "@/lib/issue-definition-contract"
import { productStorage } from "@/lib/product-storage"
import { emptyProperties } from "@/lib/template-contract"
import {
  defaultDefinitionValue,
  definitionValueSchema,
} from "@/lib/issue-definition-contract"
import {
  loadIssueDefinitions,
  persistIssueDefinitions,
} from "@/lib/issue-definition-state"
import { cachedDefinitions } from "@/lib/issue-definition-cache"
import { teamStatusesStorageKey } from "@/lib/team-statuses"
import { teamLabelsStorageKey } from "@/lib/team-labels"
import { invalidatePreferenceSession } from "@/lib/preference-session-events"
import {
  blankIssueDraft,
  getIssueStatuses,
  saveTeamIssue,
} from "@/lib/team-issues"

vi.mock("@/lib/canonical-issue-client", () => ({
  refreshCanonicalIssues: vi.fn(async () => ({ records: [] })),
}))
vi.mock("@/lib/canonical-issue-migration", () => ({
  migrateLocalIssues: vi.fn(async () => []),
}))
vi.mock("@/lib/canonical-issue-cache", () => ({
  canonicalIssuesActive: () => false,
  canonicalIssueState: () => null,
  canonicalIssueRows: () => [],
  replaceCanonicalIssues: () => {},
}))

vi.mock("@/lib/issue-definition-state", () => ({
  loadIssueDefinitions: vi.fn(),
  persistIssueDefinitions: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
const team = {
  id: "ed38ea82-49ad-4e50-bac2-e19f674b3e4c",
  slug: "engineering",
  name: "Engineering",
  icon: { kind: "emoji", value: "⚙️", color: "#94a3b8" },
} as TeamSummary
let snapshots: Array<DefinitionSnapshot>
function mount(component: React.ReactNode) {
  return render(<IssueDefinitionProvider>{component}</IssueDefinitionProvider>)
}
beforeEach(() => {
  productStorage.clear()
  snapshots = [null, team.id].map((teamId) => ({
    workspaceId: "workspace",
    teamId,
    revision: 0,
    canManage: true,
    value: defaultDefinitionValue(),
  }))
  vi.mocked(loadIssueDefinitions).mockImplementation(async () => ({
    userId: "admin",
    sessionId: "session",
    workspaceId: "workspace",
    snapshots: structuredClone(snapshots),
  }))
  vi.mocked(persistIssueDefinitions).mockImplementation(async ({ data }) => {
    const current = snapshots.find((s) => s.teamId === data.teamId)!
    if (current.revision !== data.expectedRevision)
      throw new Error("Definitions changed in another session.")
    const next = {
      ...current,
      revision: current.revision + 1,
      value: definitionValueSchema.parse(data.value),
    }
    snapshots = snapshots.map((s) => (s.teamId === next.teamId ? next : s))
    return next
  })
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
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("shared issue definitions UI", () => {
  it("saves Ready through the authenticated shared command and reloads without touching legacy data", async () => {
    const legacy = "preserved local definitions"
    productStorage.setItem(teamStatusesStorageKey(team.id), legacy)
    const view = mount(<TeamIssueStatusesSettings team={team} />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Add unstarted status" })
    )
    fireEvent.change(screen.getByRole("textbox", { name: "Status name" }), {
      target: { value: " Ready " },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save status" }))
    await screen.findByText("Ready")
    expect(
      vi.mocked(persistIssueDefinitions).mock.calls[0][0].data
    ).toMatchObject({
      teamId: team.id,
      sessionId: "session",
      workspaceId: "workspace",
      expectedRevision: 0,
    })
    expect(getIssueStatuses(team.id).some((s) => s.name === "Ready")).toBe(true)
    expect(productStorage.getItem(teamStatusesStorageKey(team.id))).toBe(legacy)
    view.unmount()
    mount(<TeamIssueStatusesSettings team={team} />)
    await screen.findByText("Ready")
  })
  it("saves Mobile, inherits workspace labels, and starts with no fictional labels", async () => {
    productStorage.setItem(teamLabelsStorageKey(team.id), "legacy labels")
    const workspace = snapshots[0]
    workspace.value.labels.labels = [
      {
        id: crypto.randomUUID(),
        name: "Workspace shared",
        description: "",
        color: "#5e6ad2",
        groupId: null,
        issues: 0,
        lastApplied: null,
        createdAt: new Date().toISOString(),
      },
    ]
    mount(<TeamIssueLabelsSettings team={team} />)
    fireEvent.click(await screen.findByRole("button", { name: "New label" }))
    expect(screen.queryByText("Desktop")).toBeNull()
    expect(screen.getByText("Workspace shared")).toBeTruthy()
    fireEvent.change(screen.getByRole("textbox", { name: "Definition name" }), {
      target: { value: "Mobile" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save label" }))
    await screen.findByText("Mobile")
    expect(cachedDefinitions(team.id).value.labels.labels[0].name).toBe(
      "Mobile"
    )
    expect(productStorage.getItem(teamLabelsStorageKey(team.id))).toBe(
      "legacy labels"
    )
  })
  it("keeps a rejected edit for correction and displays the server conflict", async () => {
    vi.mocked(persistIssueDefinitions).mockRejectedValue(
      new Error("Definitions changed in another session.")
    )
    mount(<TeamIssueStatusesSettings team={team} />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Add unstarted status" })
    )
    fireEvent.change(screen.getByRole("textbox", { name: "Status name" }), {
      target: { value: "Ready" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save status" }))
    expect((await screen.findByRole("alert")).textContent).toContain(
      "changed in another session"
    )
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Status name" })
        .value
    ).toBe("Ready")
  })
  it("makes members read only", async () => {
    snapshots = snapshots.map((s) => ({ ...s, canManage: false }))
    mount(<TeamIssueLabelsSettings team={team} />)
    expect(
      (
        await screen.findByRole<HTMLButtonElement>("button", {
          name: "New label",
        })
      ).disabled
    ).toBe(true)
    expect(persistIssueDefinitions).not.toHaveBeenCalled()
  })
  it("shares transition restrictions with local issue controls and persists workflow settings", async () => {
    mount(<TeamWorkflowsSettings team={team} />)
    const issue = await waitFor(() =>
      saveTeamIssue(team.id, {
        ...blankIssueDraft("todo"),
        title: "A local issue",
      })
    )
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Todo to Done" })
    )
    await waitFor(() =>
      expect(cachedDefinitions(team.id).value.transitions.todo).not.toContain(
        "done"
      )
    )
    expect(() =>
      saveTeamIssue(team.id, { ...issue, status: "done" }, { id: issue.id })
    ).toThrow("not allowed")
    fireEvent.click(
      screen.getByRole("switch", { name: "Auto-close parent issues" })
    )
    await waitFor(() =>
      expect(cachedDefinitions(team.id).value.workflows.closeParents).toBe(true)
    )
  })

  it("uses shared custom statuses in template and recurring property controls", async () => {
    snapshots[1].value.statuses.statuses.push({
      id: "ready",
      name: "Ready",
      group: "unstarted",
      color: "#5e6ad2",
      description: "",
    })
    const change = vi.fn()
    mount(
      <Properties
        team={team}
        value={emptyProperties(team.id)}
        onChange={change}
        directory={{
          teams: [team],
          members: [],
          templates: [],
          defaults: { members: null, nonMembers: null },
          canManage: true,
        }}
      />
    )
    fireEvent.click(
      await screen.findByRole("button", { name: "Change status" })
    )
    fireEvent.click(await screen.findByRole("option", { name: /Ready/ }))
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Ready" })
    )
  })
  it("blocks deleting statuses used by preserved local issues", async () => {
    mount(<TeamIssueStatusesSettings team={team} />)
    await screen.findByText("In Review")
    saveTeamIssue(team.id, {
      ...blankIssueDraft("in-review"),
      title: "Local review",
    })
    fireEvent.click(screen.getByRole("button", { name: "Delete In Review" }))
    fireEvent.change(
      screen.getByRole("combobox", { name: "Replacement status" }),
      { target: { value: "done" } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Delete status" }))
    expect((await screen.findByRole("alert")).textContent).toContain(
      "local issues"
    )
    expect(persistIssueDefinitions).not.toHaveBeenCalled()
  })
  it("clears shared snapshots immediately on a session switch and ignores an old pending load", async () => {
    mount(<TeamIssueLabelsSettings team={team} />)
    await screen.findByRole("button", { name: "New label" })
    act(() => invalidatePreferenceSession("start"))
    expect(() => cachedDefinitions(team.id)).toThrow("unavailable")
    expect(screen.queryByRole("button", { name: "New label" })).toBeNull()
  })
})
