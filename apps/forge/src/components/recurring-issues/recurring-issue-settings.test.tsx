import * as React from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RecurringIssueSettings } from "./recurring-issue-settings"
import type { TeamSummary } from "@/lib/team-contract"
import { emptyRecurringIssue } from "@/lib/recurring-issue-contract"

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  remove: vi.fn(),
  invalidate: vi.fn(),
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
  useRouter: () => ({ invalidate: mocks.invalidate }),
}))
vi.mock("@/lib/recurring-issue-state", () => ({
  loadRecurringIssues: mocks.load,
  deleteRecurringIssue: mocks.remove,
}))
vi.mock("@/lib/template-state", () => ({
  loadTemplates: async () => ({
    canManage: true,
    templates: [],
    teams: [],
    members: [],
    defaults: { members: null, nonMembers: null },
  }),
}))
vi.mock("./recurring-issue-editor", () => ({
  RecurringIssueEditor: () => null,
}))
vi.mock("@/components/team-sidebar-icon", () => ({
  TeamSidebarIcon: () => null,
}))
const team = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "planning",
  timezone: "Europe/Paris",
  name: "Planning",
} as TeamSummary
const saved = {
  id: "00000000-0000-4000-8000-000000000068",
  payload: {
    ...emptyRecurringIssue(team.id, team.timezone),
    title: "Daily operations",
  },
  createdAt: "2026-11-01T08:00:00Z",
  updatedAt: "2026-11-01T08:00:00Z",
  state: "active" as const,
}
afterEach(cleanup)
beforeEach(() => {
  mocks.load.mockResolvedValue([saved])
  mocks.remove.mockResolvedValue({ ok: true })
  mocks.invalidate.mockResolvedValue(undefined)
})
describe("recurring settings deletion", () => {
  it.each([false, true])(
    "removes a confirmed deletion from the current list, including refresh failure=%s",
    async (refreshFails) => {
      if (refreshFails)
        mocks.invalidate.mockRejectedValueOnce(new Error("Refresh unavailable"))
      render(<RecurringIssueSettings team={team} />)
      await screen.findByText("Daily operations")
      fireEvent.click(
        screen.getByRole("button", { name: "Options for Daily operations" })
      )
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Delete recurring issue…" })
      )
      fireEvent.click(
        screen.getByRole("button", {
          name: "Delete recurring issue",
        })
      )
      await waitFor(() => expect(mocks.remove).toHaveBeenCalled())
      await waitFor(() =>
        expect(screen.queryByText("Daily operations")).toBeNull()
      )
      expect(screen.getByText("No recurring issues")).toBeDefined()
      expect(screen.queryByRole("dialog")).toBeNull()
    }
  )
})
