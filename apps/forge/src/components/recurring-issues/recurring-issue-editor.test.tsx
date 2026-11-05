import * as React from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RecurringIssueEditor } from "./recurring-issue-editor"
import type { TeamSummary } from "@/lib/team-contract"
import { selectOption } from "@/test-utils/select-option"
import { emptyRecurringIssue } from "@/lib/recurring-issue-contract"

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  navigate: vi.fn(),
  invalidate: vi.fn(),
  blocker: vi.fn(),
  journal: new Map<string, string>(),
  saveValue: vi.fn(),
}))
vi.mock("@/lib/product-storage", () => ({
  productStorageIdentity: () => ({
    workspaceId: "workspace",
    userId: "owner",
    sessionId: "session",
  }),
  productStorage: {
    get length() {
      return mocks.journal.size
    },
    key: (i: number) => [...mocks.journal.keys()][i] ?? null,
    getItem: (key: string) => mocks.journal.get(key) ?? null,
  },
  saveProductValue: async (key: string, value: string | null) => {
    mocks.saveValue(key, value)
    if (value === null) mocks.journal.delete(key)
    else mocks.journal.set(key, value)
  },
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ invalidate: mocks.invalidate }),
  useBlocker: (options: unknown) => {
    mocks.blocker(options)
    return { status: "idle" }
  },
}))
vi.mock("@/lib/recurring-issue-state", () => ({
  saveRecurringIssue: mocks.save,
}))
vi.mock("@/components/team-icon-picker", () => ({
  TeamIconPicker: () => <button type="button">Icon</button>,
}))
vi.mock("@/components/team-sidebar-icon", () => ({
  TeamSidebarIcon: () => null,
}))
vi.mock("@/components/templates/rich-editor", () => ({
  RichEditor: () => null,
  insertFiles: vi.fn(),
}))
const team = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "testing",
  name: "Testing",
  timezone: "Europe/Paris",
  identifier: "TST",
} as TeamSummary
const directory = {
  teams: [team],
  members: [],
  templates: [],
  defaults: { members: null, nonMembers: null },
  canManage: true,
}
afterEach(cleanup)
beforeEach(() => {
  mocks.journal.clear()
  mocks.save.mockResolvedValue({ ok: true, id: "saved" })
  mocks.invalidate.mockResolvedValue(undefined)
})
describe("Recurring issue editor", () => {
  it("validates titles before saving and persists the selected date and cadence", async () => {
    render(<RecurringIssueEditor team={team} directory={directory} />)
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    expect(screen.getByRole("alert").textContent).toContain("title")
    expect(mocks.save).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "Weekly review" },
    })
    fireEvent.input(screen.getByLabelText("First due"), {
      target: { value: "2026-10-21" },
    })
    selectOption(screen.getByRole("combobox", { name: "Repeat interval" }), "2")
    selectOption(
      screen.getByRole("combobox", { name: "Repeat unit" }),
      "months"
    )
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        data: expect.objectContaining({
          slug: "testing",
          payload: expect.objectContaining({
            title: "Weekly review",
            firstDue: "2026-10-21",
            interval: 2,
            unit: "month",
          }),
        }),
      })
    )
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalled())
  })
  it("keeps a failed save editable and preserves unsaved-change protection", async () => {
    mocks.save.mockRejectedValue(new Error("Could not connect"))
    render(<RecurringIssueEditor team={team} directory={directory} />)
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "Weekly review" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Could not connect")
    )
    expect(mocks.navigate).not.toHaveBeenCalled()
    const options = mocks.blocker.mock.calls.at(-1)![0] as {
      shouldBlockFn: () => boolean
    }
    expect(options.shouldBlockFn()).toBe(true)
    expect(
      screen.getByRole<HTMLInputElement>("textbox", {
        name: "Issue title",
      }).value
    ).toBe("Weekly review")
  })
  it("replays the same command after a lost response and reload", async () => {
    mocks.save.mockRejectedValueOnce(new Error("Lost response"))
    const view = render(
      <RecurringIssueEditor team={team} directory={directory} />
    )
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "Retry me" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Lost response")
    )
    const original = mocks.save.mock.calls[0][0].data
    view.unmount()
    render(<RecurringIssueEditor team={team} directory={directory} />)
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Issue title" })
        .value
    ).toBe("Retry me")
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2))
    expect(mocks.save.mock.calls[1][0].data).toEqual(original)
  })
  it("allows repair only after the server confirms validation rolled back", async () => {
    mocks.save.mockResolvedValueOnce({
      ok: false,
      message: "Choose a current status",
    })
    render(<RecurringIssueEditor team={team} directory={directory} />)
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "First" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Choose a current status"
      )
    )
    const key = mocks.save.mock.calls[0][0].data.commandKey
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "Repaired" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2))
    expect(mocks.save.mock.calls[1][0].data.commandKey).not.toBe(key)
  })
  it("blocks save while a nested draft is open and rejects member keyboard saves", () => {
    const saved = {
      id: "saved",
      payload: {
        ...emptyRecurringIssue(team.id, team.timezone),
        title: "Saved review",
      },
      createdAt: "2026-10-11T10:00:00Z",
      updatedAt: "2026-10-11T10:00:00Z",
    }
    const { rerender } = render(
      <RecurringIssueEditor team={team} directory={directory} saved={saved} />
    )
    fireEvent.click(screen.getByRole("button", { name: "Add sub-issue" }))
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    expect(mocks.save).not.toHaveBeenCalled()
    rerender(
      <RecurringIssueEditor
        key="member"
        team={team}
        directory={{ ...directory, canManage: false }}
        saved={saved}
      />
    )
    fireEvent.keyDown(document, { key: "Enter", metaKey: true })
    expect(mocks.save).not.toHaveBeenCalled()
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Save changes",
      }).disabled
    ).toBe(true)
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Cancel",
      }).disabled
    ).toBe(false)
  })
})

it.each(["2026-0", "2026-02-31"])(
  "does not save an earlier first due date while the visible draft is %s",
  (invalid) => {
    render(<RecurringIssueEditor team={team} directory={directory} />)
    fireEvent.change(screen.getByRole("textbox", { name: "Issue title" }), {
      target: { value: "Invalid date regression" },
    })
    fireEvent.input(screen.getByLabelText("First due"), {
      target: { value: "2026-02-01" },
    })
    fireEvent.input(screen.getByLabelText("First due"), {
      target: { value: invalid },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create" }))
    fireEvent.keyDown(document, { key: "Enter", ctrlKey: true })
    expect(mocks.save).not.toHaveBeenCalled()
  }
)
