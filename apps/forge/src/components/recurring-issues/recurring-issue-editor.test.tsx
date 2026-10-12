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
import { emptyRecurringIssue } from "@/lib/recurring-issue-contract"

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  navigate: vi.fn(),
  invalidate: vi.fn(),
  blocker: vi.fn(),
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
  mocks.save.mockResolvedValue({ id: "saved" })
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
    fireEvent.change(
      screen.getByRole("combobox", { name: "Repeat interval" }),
      { target: { value: "2" } }
    )
    fireEvent.change(screen.getByRole("combobox", { name: "Repeat unit" }), {
      target: { value: "month" },
    })
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
