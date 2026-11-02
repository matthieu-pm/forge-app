import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TeamLoops } from "./team-home-loops"
import { LoopConditionEditor } from "./loop-configuration"
import type { LoopFields, LoopSnapshot, SharedLoop } from "@/lib/loop-contract"
import type { TeamSummary } from "@/lib/team-contract"

const fixture = vi.hoisted(() => ({
  snapshot: null as LoopSnapshot | null,
  ready: true,
  error: "",
  pending: [] as Array<any>,
  command: vi.fn(),
  retry: vi.fn(),
  refresh: vi.fn(),
  legacy: [] as Array<any>,
  update: vi.fn(),
  invalidate: null as null | (() => void),
}))
vi.mock("@/lib/loop-client", () => ({ useTeamLoops: () => fixture }))
vi.mock("@/lib/team-home-state", () => ({
  useTeamHome: () => ({
    state: {
      favorite: false,
      sections: [],
      resources: [],
      loops: fixture.legacy,
    },
    ready: true,
    error: null,
    update: fixture.update,
  }),
}))
vi.mock("@/lib/preference-session-events", () => ({
  onPreferenceSessionInvalidated: (callback: () => void) => {
    fixture.invalidate = callback
    return () => {
      fixture.invalidate = null
    }
  },
}))
vi.mock("./team-home", () => ({
  TeamHomeLayout: ({
    children,
    actions,
  }: {
    children: React.ReactNode
    actions: React.ReactNode
  }) => (
    <section>
      {actions}
      {children}
    </section>
  ),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const fields: LoopFields = {
  name: "Investigate",
  description: "Review incoming bugs",
  instructions: "Read the issue and suggest next steps.",
  trigger: { kind: "event", entity: "issue", event: "created" },
  conditions: [],
  reasoning: "auto",
  teamAccess: "this-team",
}
const loop: SharedLoop = {
  ...fields,
  id: "f6d0a6cd-4cde-45bf-ae28-56b8ee9c0640",
  revision: 1,
  enabled: true,
  enabledById: "alice",
  updatedAt: "2026-11-02T12:00:00Z",
}
const team = {
  id: "94aef4b1-36f1-4b85-9e9d-e98135ea3599",
  slug: "forge",
  name: "Forge",
  visibility: "workspace",
  timezone: "Europe/Paris",
} as TeamSummary
beforeEach(() => {
  fixture.snapshot = {
    loops: [loop],
    runs: [],
    enabled: true,
    choices: {
      issue: [
        {
          id: "bf8224d9-82c8-4901-96fa-77b94871b3af",
          name: "FOR-1 Fix the button",
        },
      ],
    },
  }
  fixture.ready = true
  fixture.error = ""
  fixture.pending = []
  fixture.legacy = []
  fixture.command.mockResolvedValue({
    status: "saved",
    id: loop.id,
    revision: 2,
  })
})
afterEach(cleanup)
describe("Real team Loops", () => {
  it("retains nested AND grouping when editing inside an OR group", () => {
    const onChange = vi.fn()
    render(
      <LoopConditionEditor
        entity="issue"
        onChange={onChange}
        conditions={[
          {
            operator: "or",
            conditions: [
              { field: "priority", operator: "is", values: ["high"] },
              {
                operator: "and",
                conditions: [
                  { field: "status", operator: "is", values: ["todo"] },
                  { field: "labels", operator: "any", values: ["bug"] },
                ],
              },
            ],
          },
        ]}
      />
    )
    fireEvent.click(
      screen.getAllByRole("button", { name: "Remove condition 1" })[1]
    )
    expect(onChange).toHaveBeenCalledWith([
      {
        operator: "or",
        conditions: [
          { field: "priority", operator: "is", values: ["high"] },
          {
            operator: "and",
            conditions: [{ field: "labels", operator: "any", values: ["bug"] }],
          },
        ],
      },
    ])
  })
  it("surfaces a definitive rejection without closing the author’s draft", async () => {
    fixture.command.mockResolvedValueOnce({
      status: "rejected",
      message: "No workspace cloud model is available",
    })
    render(<TeamLoops team={team} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    fireEvent.click(screen.getByRole("button", { name: "Publish loop" }))
    await waitFor(() =>
      expect(
        screen.getByText("No workspace cloud model is available")
      ).toBeTruthy()
    )
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Loop instructions").value
    ).toBe(fields.instructions)
  })

  it("publishes a real shared definition and has no fictional integration templates", async () => {
    render(<TeamLoops team={team} />)
    fireEvent.click(screen.getByRole("button", { name: "New loop" }))
    fireEvent.change(screen.getByLabelText("Loop name"), {
      target: { value: "Incoming bug review" },
    })
    fireEvent.change(screen.getByLabelText("Loop instructions"), {
      target: { value: "Review the incoming issue" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Publish loop" }))
    await waitFor(() => expect(fixture.command).toHaveBeenCalledTimes(1))
    expect(fixture.command.mock.calls[0][0]).toMatchObject({
      action: "create",
      fields: {
        name: "Incoming bug review",
        instructions: "Review the incoming issue",
        teamAccess: "all-public-teams",
      },
    })
    expect(screen.queryByText("Autofix bugs")).toBeNull()
    expect(screen.queryByText("Slack Q&A assistant")).toBeNull()
    expect(fixture.update).not.toHaveBeenCalled()
  })
  it("preserves a stale draft and requires explicit latest-version review before saving it", async () => {
    fixture.command.mockResolvedValueOnce({
      status: "conflict",
      current: {
        ...loop,
        revision: 2,
        instructions: "Alice’s latest saved instructions",
      },
    })
    render(<TeamLoops team={team} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    fireEvent.change(screen.getByLabelText("Loop instructions"), {
      target: { value: "Bob’s unsaved instructions" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Publish loop" }))
    await waitFor(() =>
      expect(screen.getByText("Alice’s latest saved instructions")).toBeTruthy()
    )
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Loop instructions").value
    ).toBe("Bob’s unsaved instructions")
    fireEvent.click(
      screen.getByRole("button", { name: "Use latest revision with my draft" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Publish loop" }))
    await waitFor(() => expect(fixture.command).toHaveBeenCalledTimes(2))
    expect(fixture.command.mock.calls[1][0]).toMatchObject({
      action: "save",
      expectedRevision: 2,
      fields: { instructions: "Bob’s unsaved instructions" },
    })
  })
  it("hides a protected editor as soon as current team authorization is lost", () => {
    const rendered = render(<TeamLoops team={team} />)
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    expect(screen.getByLabelText("Loop instructions")).toBeTruthy()
    fixture.snapshot = null
    fixture.error = "Access revoked"
    rendered.rerender(<TeamLoops team={team} />)
    expect(screen.queryByLabelText("Loop instructions")).toBeNull()
    expect(screen.queryByText(loop.description)).toBeNull()
  })
  it("keeps local drafts preserved and imports only an explicitly reviewed copy", () => {
    const legacy = {
      id: "old",
      name: "Device draft",
      prompt: "Local instructions",
      trigger: "Manual",
      updatedAt: "2026-11-02T12:00:00Z",
    }
    fixture.legacy = [legacy]
    render(<TeamLoops team={team} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Review draft: Device draft" })
    )
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Loop instructions").value
    ).toBe("Local instructions")
    expect(fixture.command).not.toHaveBeenCalled()
    expect(fixture.update).not.toHaveBeenCalled()
    expect(fixture.legacy).toEqual([legacy])
  })
  it("uses published run approval identity and explicit cancellation commands", async () => {
    const runId = "9b0db3c8-7b79-4903-861e-5c63331c2754",
      approvalId = "71602a29-3ac2-46f0-a86e-b3330dc86c9e",
      inputHash = "a".repeat(64)
    fixture.snapshot!.runs = [
      {
        id: runId,
        loopId: loop.id,
        state: "waiting-for-approval",
        createdAt: "2026-11-02T12:00:00Z",
        errorCode: null,
        threadId: null,
        result: null,
        approvals: [
          { id: approvalId, inputHash, summary: "Change the issue status" },
        ],
      },
    ]
    render(<TeamLoops team={team} />)
    fireEvent.click(screen.getByRole("button", { name: "Approve action" }))
    await waitFor(() =>
      expect(fixture.command).toHaveBeenCalledWith({
        action: "approve",
        id: loop.id,
        expectedRevision: 1,
        runId,
        approvalId,
        inputHash,
      })
    )
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Cancel run" })
          .hasAttribute("disabled")
      ).toBe(false)
    )
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }))
    await waitFor(() =>
      expect(fixture.command).toHaveBeenCalledWith({
        action: "cancel-run",
        id: loop.id,
        expectedRevision: 1,
        runId,
      })
    )
  })
  it("does not expose mutation controls while the server gate is disabled", () => {
    fixture.snapshot = { loops: [], runs: [], enabled: false }
    render(<TeamLoops team={team} />)
    expect(
      screen.getByRole("button", { name: "New loop" }).hasAttribute("disabled")
    ).toBe(true)
    expect(
      screen.getByText("Loops are not enabled in this environment.")
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Enable" })).toBeNull()
  })
})
