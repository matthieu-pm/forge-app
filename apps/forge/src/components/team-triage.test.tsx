import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TeamTriage } from "./team-triage"
import { TeamTriageSettings } from "./team-triage-settings"
import type { ReactNode } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import { productStorage } from "@/lib/product-storage"
import {
  initialTeamTriage,
  teamTriageStorageKey,
  useEnabledTeamTriage,
} from "@/lib/team-triage"
import {
  parseTriageIssues,
  triageDraftKey,
  triageIssuesKey,
} from "@/lib/triage-issues"
import { emptyTemplate } from "@/lib/template-contract"
import { loadTemplates } from "@/lib/template-state"
import { buildYourTeamsNav } from "@/lib/app-navigation"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))
vi.mock("@/lib/template-state", () => ({
  loadTemplates: vi.fn().mockResolvedValue({
    templates: [],
    defaults: { members: null, nonMembers: null },
    teams: [],
    members: [],
    canManage: true,
  }),
}))
const team = {
  id: "triage-test",
  slug: "product",
  name: "Product",
  identifier: "PRO",
  icon: { kind: "emoji", value: "🔥", color: "#94a3b8" },
} as TeamSummary
beforeEach(() => {
  productStorage.clear()
  productStorage.setItem(
    teamTriageStorageKey(team.id),
    JSON.stringify({ ...initialTeamTriage(), enabled: true })
  )
})
afterEach(cleanup)
async function create(title: string) {
  fireEvent.click(
    screen.getAllByRole("button", { name: "Create triage issue" })[0]
  )
  fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
    target: { value: title },
  })
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Create issue" }))
  )
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
describe("team triage", async () => {
  it("updates navigation immediately from the team settings switch", async () => {
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
    await create("Investigate request")
    expect(
      screen.getByRole("heading", { name: "Investigate request" })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Edit issue" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "Updated request" },
    })
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Save issue" }))
    )
    view.unmount()
    render(<TeamTriage team={team} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Open PRO-T1 Updated request" })
    )
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Snooze" }))
    )
    expect(
      screen.queryByRole("button", { name: "Open PRO-T1 Updated request" })
    ).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Display options" }))
    fireEvent.click(await screen.findByRole("switch", { name: "Show snoozed" }))
    expect(
      screen.getByRole("button", { name: "Open PRO-T1 Updated request" })
    ).toBeTruthy()
    expect(
      parseTriageIssues(productStorage.getItem(triageIssuesKey(team.id))!)[0]
        .snoozed
    ).toBe(true)
  })
  it("gates direct navigation and responds to settings changes", async () => {
    render(<TeamTriage team={team} />)
    act(() => {
      productStorage.setItem(
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
  it("isolates team issues and preserves corrupted data", async () => {
    const view = render(<TeamTriage team={team} />)
    await create("Private request")
    view.unmount()
    productStorage.setItem(
      teamTriageStorageKey("other"),
      JSON.stringify({ ...initialTeamTriage(), enabled: true })
    )
    productStorage.setItem(triageIssuesKey("other"), "broken")
    render(<TeamTriage team={{ ...team, id: "other" }} />)
    expect(screen.queryByText("Private request")).toBeNull()
    expect(screen.getByRole("alert").textContent).toContain("preserved")
    expect(productStorage.getItem(triageIssuesKey("other"))).toBe("broken")
  })
  it("retains drafts after a storage failure", async () => {
    render(<TeamTriage team={team} />)
    const fail = vi.spyOn(productStorage, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    await create("Keep my draft")
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
    await create("Low urgency")
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Priority" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Urgent" }))
    expect(
      screen.queryByRole("button", { name: "Open PRO-T1 Low urgency" })
    ).toBeNull()
    expect(
      parseTriageIssues(productStorage.getItem(triageIssuesKey(team.id))!)
    ).toHaveLength(1)
  })
  it("restores a saved draft after remount and clears it after creation", async () => {
    const view = render(<TeamTriage team={team} />)
    fireEvent.click(
      screen.getAllByRole("button", { name: "Create triage issue" })[0]
    )
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "Resume this" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }))
    expect(productStorage.getItem(triageIssuesKey(team.id))).toBeNull()
    expect(
      JSON.parse(productStorage.getItem(triageDraftKey(team.id))!).title
    ).toBe("Resume this")
    view.unmount()
    render(<TeamTriage team={team} />)
    fireEvent.click(
      screen.getAllByRole("button", { name: "Create triage issue" })[0]
    )
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Issue title" })
        .value
    ).toBe("Resume this")
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Create issue" }))
    )
    expect(productStorage.getItem(triageDraftKey(team.id))).toBeNull()
    fireEvent.click(
      screen.getAllByRole("button", { name: "Create triage issue" })[0]
    )
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Issue title" })
        .value
    ).toBe("")
  })
  it("creates consecutive issues without closing the composer", async () => {
    render(<TeamTriage team={team} />)
    fireEvent.click(
      screen.getAllByRole("button", { name: "Create triage issue" })[0]
    )
    fireEvent.click(screen.getByRole("switch", { name: "Create more" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "First request" },
    })
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Create issue" }))
    )
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Issue title" })
        .value
    ).toBe("")
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "Second request" },
    })
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Create issue" }))
    )
    expect(
      parseTriageIssues(productStorage.getItem(triageIssuesKey(team.id))!).map(
        (issue) => issue.title
      )
    ).toEqual(["First request", "Second request"])
  })
  it("preserves unreadable drafts when saving fails", async () => {
    productStorage.setItem(triageDraftKey(team.id), "corrupt draft")
    render(<TeamTriage team={team} />)
    fireEvent.click(
      screen.getAllByRole("button", { name: "Create triage issue" })[0]
    )
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "Keep this too" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }))
    expect(productStorage.getItem(triageDraftKey(team.id))).toBe(
      "corrupt draft"
    )
    expect(
      within(screen.getByRole("dialog")).getByRole("alert").textContent
    ).toContain("preserved")
  })
  it("applies a team template and persists properties and attachments", async () => {
    const template = emptyTemplate("issue")
    template.name = "Bug report"
    template.title = "Investigate bug"
    template.content = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Reproduction steps" }],
        },
      ],
    }
    template.properties.priority = "High"
    template.properties.project = "Website"
    template.properties.labels = ["Bug"]
    template.properties.assignee = "member-1"
    vi.mocked(loadTemplates).mockResolvedValueOnce({
      templates: [
        {
          id: "template-1",
          payload: template,
          createdBy: "member-1",
          createdAt: "",
          updatedAt: "",
        },
      ],
      defaults: { members: null, nonMembers: null },
      teams: [team],
      members: [{ id: "member-1", name: "Alex", image: null }],
      canManage: true,
    })
    render(<TeamTriage team={team} />)
    fireEvent.click(
      screen.getAllByRole("button", { name: "Create triage issue" })[0]
    )
    fireEvent.click(screen.getByRole("button", { name: "Apply template" }))
    fireEvent.click(await screen.findByRole("button", { name: "Bug report" }))
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Issue title" })
        .value
    ).toBe("Investigate bug")
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Description" })
        .value
    ).toBe("Reproduction steps")
    fireEvent.change(screen.getByLabelText("Issue attachments"), {
      target: {
        files: [new File(["example"], "example.txt", { type: "text/plain" })],
      },
    })
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Remove example.txt" })
      ).toBeTruthy()
    )
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Create issue" }))
    )
    const [issue] = parseTriageIssues(
      productStorage.getItem(triageIssuesKey(team.id))!
    )
    expect(issue).toMatchObject({
      priority: "High",
      project: "Website",
      labels: "Bug",
      assignee: "member-1",
      templateName: "Bug report",
    })
    expect(issue.attachments?.[0]).toMatchObject({
      name: "example.txt",
      data: "data:text/plain;base64,ZXhhbXBsZQ==",
    })
    expect(
      screen.getByRole("link", { name: "example.txt" }).getAttribute("download")
    ).toBe("example.txt")
  })
})
