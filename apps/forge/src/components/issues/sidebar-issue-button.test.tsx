import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SidebarIssueButton } from "./sidebar-issue-button"
import type { ComponentProps } from "react"
import type { IssueComposer } from "./issue-composer"
import type { TeamSummary } from "@/lib/team-contract"
import { productStorage } from "@/lib/product-storage"

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  navigate: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: mocks.navigate }),
}))
vi.mock("@/lib/template-state", () => ({ loadTemplates: mocks.load }))
vi.mock("sonner", () => ({
  toast: { error: mocks.error, info: mocks.info, success: vi.fn() },
}))
vi.mock("./issue-composer", () => ({
  IssueComposer: ({ team, onClose }: ComponentProps<typeof IssueComposer>) => (
    <div role="dialog" aria-label={`New issue in ${team.name}`}>
      <button onClick={onClose}>Close composer</button>
    </div>
  ),
}))
const forge: TeamSummary = {
  id: "forge",
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
  createdAt: "2026-10-24T08:00:00Z",
}
const skema = { ...forge, id: "skema", slug: "skema", name: "SKEMA" }

beforeEach(() => {
  vi.clearAllMocks()
  productStorage.clear()
  mocks.load.mockResolvedValue({
    teams: [forge, skema],
    templates: [],
    members: [],
    canManage: false,
    defaults: { members: null, nonMembers: null },
  })
})
afterEach(cleanup)

it("opens in the current team and closes without navigating away", async () => {
  render(<SidebarIssueButton pathname="/teams/skema/projects" />)
  expect(mocks.load).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Create new issue" }))
  expect(
    await screen.findByRole("dialog", { name: "New issue in SKEMA" })
  ).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Close composer" }))
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(mocks.navigate).not.toHaveBeenCalled()
})

it("uses an available team on workspace pages", async () => {
  render(<SidebarIssueButton pathname="/my-issues" />)
  fireEvent.click(screen.getByRole("button", { name: "Create new issue" }))
  expect(
    await screen.findByRole("dialog", { name: "New issue in Forge" })
  ).toBeTruthy()
})

it("offers recovery when loading fails or no team is available", async () => {
  mocks.load.mockRejectedValueOnce(new Error("Unavailable"))
  render(<SidebarIssueButton pathname="/inbox" />)
  const button = screen.getByRole("button", { name: "Create new issue" })
  fireEvent.click(button)
  await waitFor(() => expect(mocks.error).toHaveBeenCalled())
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false))
  mocks.load.mockResolvedValueOnce({ teams: [] })
  fireEvent.click(button)
  await waitFor(() => expect(mocks.info).toHaveBeenCalled())
  expect(screen.queryByRole("dialog")).toBeNull()
  const options = mocks.info.mock.calls[0][1]
  options.action.onClick()
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/workspace/teams" })
})
