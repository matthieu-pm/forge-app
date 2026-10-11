import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TeamMembersSettings } from "./team-members-settings"
import type { TeamSummary } from "@/lib/team-contract"
import type { TeamMemberDirectory } from "@/lib/team-member-contract"
import { teamMembersCsv } from "@/lib/team-member-contract"

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  invalidate: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: mocks.invalidate }),
  Link: ({ children, params, to, search: _search, ...props }: any) => (
    <a href={to.replace("$teamSlug", params?.teamSlug ?? "")} {...props}>
      {children}
    </a>
  ),
}))
vi.mock("@/lib/team-member-state", () => ({ addTeamMembers: mocks.add }))
vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}))
beforeEach(() => {
  vi.clearAllMocks()
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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const team: TeamSummary = {
  id: "team",
  slug: "forge",
  name: "Forge",
  identifier: "FOR",
  icon: { kind: "emoji", value: "✦", color: "#818cf8" },
  timezone: "Europe/Paris",
  description: "",
  visibility: "workspace",
  estimationScheme: "none",
  issueEmailEnabled: false,
  detailedHistoryEnabled: false,
  createdAt: "2026-10-10T00:00:00Z",
}
const directory: TeamMemberDirectory = {
  canManage: true,
  members: [
    {
      userId: "admin",
      name: "Ada Admin",
      email: "ada@example.com",
      username: "ada",
      image: null,
      workspaceRole: "owner",
      teamRole: "member",
    },
    {
      userId: "member",
      name: "Zoe Member",
      email: "zoe@example.com",
      username: "zoe",
      image: null,
      workspaceRole: "member",
      teamRole: "member",
    },
  ],
  availableMembers: [
    {
      userId: "new-user",
      name: "New Member",
      email: "new@example.com",
      username: null,
      image: null,
      workspaceRole: "member",
      teamRole: null,
    },
  ],
}

describe("team members settings", () => {
  it("searches by email and restores the table after an empty search", () => {
    render(<TeamMembersSettings team={team} directory={directory} />)
    const search = screen.getByRole("textbox", {
      name: "Search team members by name or email",
    })
    fireEvent.change(search, { target: { value: "ada@example" } })
    expect(screen.getByText("Ada Admin")).toBeTruthy()
    expect(screen.queryByText("Zoe Member")).toBeNull()
    fireEvent.change(search, { target: { value: "missing" } })
    expect(screen.getByText("No matching members")).toBeTruthy()
    fireEvent.change(search, { target: { value: "" } })
    expect(screen.getByText("Zoe Member")).toBeTruthy()
  })
  it("adds the selected member to the current team and refreshes data", async () => {
    mocks.add.mockResolvedValue({ ok: true })
    render(<TeamMembersSettings team={team} directory={directory} />)
    fireEvent.click(screen.getByRole("button", { name: "Add a member" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Select members" })
    )
    fireEvent.click(await screen.findByRole("checkbox", { name: "New Member" }))
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search members" }), {
      key: "Escape",
    })
    fireEvent.click(screen.getByRole("button", { name: /^Add members$/ }))
    await waitFor(() =>
      expect(mocks.add).toHaveBeenCalledWith({
        data: { slug: "forge", userIds: ["new-user"] },
      })
    )
    await waitFor(() => expect(mocks.invalidate).toHaveBeenCalled())
    expect(mocks.success).toHaveBeenCalledWith("Member added to Forge.")
  })
  it("hides additions for readers", () => {
    render(
      <TeamMembersSettings
        team={team}
        directory={{ ...directory, canManage: false }}
      />
    )
    expect(screen.queryByRole("button", { name: "Add a member" })).toBeNull()
  })
  it("searches by email and toggles multiple members before submitting together", async () => {
    mocks.add.mockResolvedValue({ ok: true })
    render(
      <TeamMembersSettings
        team={team}
        directory={{
          ...directory,
          availableMembers: [
            ...directory.availableMembers,
            {
              ...directory.availableMembers[0],
              userId: "second",
              name: "Second Member",
              email: "second@example.com",
            },
          ],
        }}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Add a member" }))
    expect(
      screen
        .getByRole("button", { name: /^Add members$/ })
        .hasAttribute("disabled")
    ).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Select members" }))
    const search = await screen.findByRole("textbox", {
      name: "Search members",
    })
    fireEvent.change(search, { target: { value: "second@example" } })
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "New Member" })).toBeNull()
    )
    fireEvent.click(screen.getByRole("checkbox", { name: "Second Member" }))
    fireEvent.change(search, { target: { value: "" } })
    fireEvent.click(await screen.findByRole("checkbox", { name: "New Member" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "New Member" }))
    expect(
      screen
        .getByRole("checkbox", { name: "New Member" })
        .getAttribute("aria-checked")
    ).toBe("false")
    fireEvent.click(screen.getByRole("checkbox", { name: "New Member" }))
    fireEvent.keyDown(search, { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: /^Add members$/ }))
    await waitFor(() =>
      expect(mocks.add).toHaveBeenCalledWith({
        data: { slug: "forge", userIds: ["second", "new-user"] },
      })
    )
    expect(mocks.success).toHaveBeenCalledWith("Members added to Forge.")
  })
  it("keeps selections after a failed save and clears them when canceled", async () => {
    mocks.add.mockResolvedValue({
      ok: false,
      message: "Unable to add members.",
    })
    render(<TeamMembersSettings team={team} directory={directory} />)
    fireEvent.click(screen.getByRole("button", { name: "Add a member" }))
    fireEvent.click(screen.getByRole("button", { name: "Select members" }))
    fireEvent.click(await screen.findByRole("checkbox", { name: "New Member" }))
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search members" }), {
      key: "Escape",
    })
    fireEvent.click(screen.getByRole("button", { name: /^Add members$/ }))
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("Unable to add members.")
    )
    expect(
      screen.getByRole("button", { name: "Select members" }).textContent
    ).toContain("New Member")
    expect(mocks.invalidate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Add members to Forge" })
      ).toBeNull()
    )
    fireEvent.click(screen.getByRole("button", { name: "Add a member" }))
    expect(
      screen.getByRole("button", { name: "Select members" }).textContent
    ).toContain("Select members...")
  })
  it("escapes CSV data and prevents spreadsheet formulas", () => {
    const csv = teamMembersCsv([
      { ...directory.members[0], name: '=HYPERLINK("test")' },
    ])
    expect(csv).toContain('"\'=HYPERLINK(""test"")"')
    expect(csv).toContain('"Workspace admin"')
  })
})
