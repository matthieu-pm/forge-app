import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CallsPage } from "./calls-page"
import { CallDetail } from "./call-detail"
import type { ComponentProps } from "react"
import type { CallRecord, CallsDirectory } from "@/lib/calls"
import type { TeamSummary } from "@/lib/team-contract"
import { addNote, loadCall, updateCallAction } from "@/lib/calls-state"
import { selectOption } from "@/test-utils/select-option"
import { readIssueStore } from "@/lib/team-issues"
import { createSimulatedCalls } from "@/lib/calls-demo"

vi.mock("@/lib/calls-state", () => ({
  loadCall: vi.fn(),
  loadCalls: vi.fn(),
  addNote: vi.fn(),
  updateCallAction: vi.fn(),
  generateCallRecap: vi.fn(),
  connectMeetingProvider: vi.fn(),
  disconnectMeetingProvider: vi.fn(),
  updateCallRetention: vi.fn(),
  syncMeetingCalls: vi.fn(),
  uploadCall: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    search,
    params: _params,
    ...rest
  }: ComponentProps<"a"> & {
    to: string
    search: Record<string, string>
    params?: unknown
  }) => (
    <a {...rest} href={`${to}?${new URLSearchParams(search)}`}>
      {children}
    </a>
  ),
}))
const team: TeamSummary = {
  id: "862f4136-7535-44ce-8304-dd8784581967",
  name: "Product",
  slug: "product",
  identifier: "PRD",
  icon: { kind: "icon", value: "CubeIcon", color: "#94a3b8" },
  timezone: "Europe/Paris",
  description: "",
  visibility: "workspace",
  estimationScheme: "none",
  issueEmailEnabled: false,
  detailedHistoryEnabled: true,
  createdAt: new Date().toISOString(),
}
const call: CallRecord = {
  id: "c27aa38f-e45a-4291-87d9-d029c084d369",
  teamId: team.id,
  title: "Onboarding review",
  provider: "google",
  startedAt: new Date().toISOString(),
  duration: 25,
  participants: ["Alex", "Sam"],
  summary: "The team will test a shorter flow.",
  decisions: ["Use five participants."],
  transcript: [
    { speaker: "Alex", seconds: 12, text: "Keep the scope small." },
    { speaker: "Sam", seconds: 60, text: "I will recruit five participants." },
  ],
  status: "ready",
  summaryStatus: "ready",
  actions: [
    {
      id: "f2b89a9f-7bc1-4137-be56-1f915c6ef4f2",
      title: "Recruit five participants",
      owner: "Sam",
      completed: false,
    },
  ],
  notes: [],
}
const directory: CallsDirectory = {
  calls: [call],
  connections: [],
  canManage: true,
  retentionDays: 30,
  configuredProviders: [],
}
afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(loadCall).mockResolvedValue(call)
})
describe("Calls", () => {
  it("uses the shared resizable sidebar and moves between calls with arrow keys", async () => {
    const select = vi.fn()
    render(
      <CallsPage
        initialDirectory={{ ...directory, calls: [] }}
        teams={[team]}
        teamId={team.id}
        scope={{ workspaceId: "workspace", userId: "user" }}
        creator="user"
        onSelect={select}
        simulateWhenEmpty
      />
    )
    const first = await screen.findByRole("button", {
      name: "Open call: Weekly product planning",
    })
    const second = screen.getByRole("button", {
      name: "Open call: Onboarding design review",
    })
    first.focus()
    fireEvent.keyDown(first, { key: "ArrowDown" })
    expect(select).toHaveBeenLastCalledWith(createSimulatedCalls([team])[1].id)
    expect(document.activeElement).toBe(second)
    fireEvent.keyDown(second, { key: "ArrowUp" })
    expect(document.activeElement).toBe(first)
    const resize = screen.getByRole("separator", {
      name: "Resize calls sidebar",
    })
    fireEvent.keyDown(resize, { key: "ArrowRight" })
    expect(resize.getAttribute("aria-valuenow")).toBe("105")
    expect(
      localStorage.getItem('forge:calls-sidebar-width:v1:["workspace","user"]')
    ).toBe("1.05")
  })
  it("populates an empty directory with usable samples and persists local notes and actions", async () => {
    const props = {
      initialDirectory: { ...directory, calls: [] },
      teams: [team],
      creator: "user",
      onSelect: vi.fn(),
      simulateWhenEmpty: true,
    }
    const page = render(<CallsPage {...props} />)
    await screen.findByRole("heading", { name: "At a glance" })
    expect(screen.getByText("Simulated data")).toBeTruthy()
    expect(
      screen.getByRole("heading", { name: "Weekly product planning", level: 1 })
    ).toBeTruthy()
    expect(loadCall).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Verify draft recovery when switching teams",
      })
    )
    await waitFor(() =>
      expect(
        screen
          .getByRole("checkbox", {
            name: "Verify draft recovery when switching teams",
          })
          .getAttribute("aria-checked")
      ).toBe("true")
    )
    expect(updateCallAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("tab", { name: "Transcript" }))
    expect(screen.getByText(/Draft recovery should go first/)).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: /^Notes/ }))
    fireEvent.change(
      screen.getByRole("textbox", { name: "Add a note or follow-up" }),
      { target: { value: "Recheck the draft flow on Friday." } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Add note" }))
    expect(
      await screen.findByText("Recheck the draft flow on Friday.")
    ).toBeTruthy()
    expect(addNote).not.toHaveBeenCalled()
    page.unmount()
    render(<CallsPage {...props} />)
    await screen.findByRole("heading", { name: "At a glance" })
    expect(
      screen
        .getByRole("checkbox", {
          name: "Verify draft recovery when switching teams",
        })
        .getAttribute("aria-checked")
    ).toBe("true")
    fireEvent.click(screen.getByRole("tab", { name: /^Notes/ }))
    expect(screen.getByText("Recheck the draft flow on Friday.")).toBeTruthy()
  })
  it("uses stable call links across workspace and team views", () => {
    const other = { id: "7999fe9e-c035-4768-9fdc-d9d1f88f53f2" }
    const now = new Date("2026-10-27T12:00:00Z")
    const teamCalls = createSimulatedCalls([team], now)
    const workspaceCalls = createSimulatedCalls([other, team], now)
    expect(workspaceCalls.filter((item) => item.teamId === team.id)).toEqual(
      teamCalls
    )
    expect(new Set(workspaceCalls.map((item) => item.id)).size).toBe(12)
    expect(
      teamCalls.every(
        (item) => item.transcript.length > 0 && item.actions.length > 0
      )
    ).toBe(true)
    expect(
      teamCalls.every((item) =>
        /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
          item.id
        )
      )
    ).toBe(true)
  })
  it("explains native connections and keeps unconfigured providers disconnected", () => {
    render(
      <CallsPage
        initialDirectory={{ ...directory, calls: [] }}
        teams={[team]}
        creator="user"
        onSelect={vi.fn()}
      />
    )
    expect(
      screen.getByRole("heading", { name: "Calls", level: 2 })
    ).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Connect a meeting tool" })
    )
    expect(screen.getByText("Microsoft Teams")).toBeTruthy()
    expect(
      screen
        .getAllByRole("button", { name: "Connect" })
        .every((button) => button.hasAttribute("disabled"))
    ).toBe(true)
    expect(screen.getByLabelText("Keep transcripts for")).toBeTruthy()
  })
  it("shows day grouping, call metadata and no-match recovery", async () => {
    render(
      <CallsPage
        simulateWhenEmpty
        initialDirectory={directory}
        teams={[team]}
        creator="user"
        onSelect={vi.fn()}
      />
    )
    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy()
    await screen.findByRole("heading", { name: "At a glance" })
    expect(screen.queryByText("Simulated data")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Search calls" }))
    fireEvent.change(screen.getByRole("searchbox", { name: "Search calls" }), {
      target: { value: "does not exist" },
    })
    expect(
      screen.getByRole("heading", { name: "No matching calls" })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy()
  })
  it("searches transcripts and turns actions into linked issues", () => {
    render(
      <CallDetail
        call={call}
        team={team}
        creator="user"
        retentionDays={30}
        onRefresh={vi.fn()}
        onBack={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Create issue" }))
    expect(readIssueStore(team.id).issues[0].title).toBe(
      "Recruit five participants"
    )
    expect(screen.getByRole("link", { name: "PRD-1" })).toBeTruthy()
    fireEvent.click(screen.getByRole("tab", { name: "Transcript" }))
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search transcript" }),
      { target: { value: "recruit" } }
    )
    expect(screen.getByText("I will recruit five participants.")).toBeTruthy()
    expect(screen.queryByText("Keep the scope small.")).toBeNull()
  })
  it("saves follow-ups through the server and completes action items", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    render(
      <CallDetail
        call={call}
        team={team}
        creator="user"
        retentionDays={30}
        onRefresh={refresh}
        onBack={vi.fn()}
      />
    )
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Recruit five participants",
      })
    )
    await waitFor(() =>
      expect(updateCallAction).toHaveBeenCalledWith({
        data: {
          callId: call.id,
          actionId: call.actions[0].id,
          completed: true,
        },
      })
    )
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    fireEvent.click(screen.getByRole("tab", { name: /^Notes/ }))
    fireEvent.change(
      screen.getByRole("textbox", { name: "Add a note or follow-up" }),
      { target: { value: "Review recruitment on Friday." } }
    )
    selectOption(
      screen.getByRole("combobox", { name: "Note type" }),
      "Follow-up"
    )
    fireEvent.click(screen.getByRole("button", { name: "Add note" }))
    await waitFor(() =>
      expect(addNote).toHaveBeenCalledWith({
        data: {
          callId: call.id,
          body: "Review recruitment on Friday.",
          kind: "follow-up",
        },
      })
    )
  })
  it("keeps expired transcript text out of the detail view", () => {
    render(
      <CallDetail
        call={{ ...call, status: "expired", transcript: [] }}
        team={team}
        creator="user"
        retentionDays={7}
        onRefresh={vi.fn()}
        onBack={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole("tab", { name: "Transcript" }))
    expect(
      screen.getByRole("heading", { name: "Transcript removed" })
    ).toBeTruthy()
    expect(screen.queryByText("Keep the scope small.")).toBeNull()
  })
})
