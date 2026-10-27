import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WorkspaceMembers } from "./workspace-members"
import type {
  WorkspaceAccessSummary,
  WorkspaceMemberSummary,
} from "@/lib/member-contract"
import type { TeamDirectoryEntry } from "@/lib/team-contract"
import { selectOption } from "@/test-utils/select-option"

const mocks = vi.hoisted(() => ({
  invite: vi.fn(),
  invalidate: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/member-state", () => ({ inviteWorkspaceMember: mocks.invite }))
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: mocks.invalidate }),
  Link: ({
    children,
    params,
    to,
    ...props
  }: React.ComponentProps<"a"> & {
    to: string
    params: { teamSlug: string }
  }) => (
    <a {...props} href={to.replace("$teamSlug", params.teamSlug)}>
      {children}
    </a>
  ),
}))
const member = (
  id: string,
  name: string,
  role: string,
  online = false
): WorkspaceMemberSummary => ({
  id,
  userId: id,
  name,
  role,
  isOnline: online,
  email: `${id}@forge.test`,
  image: null,
  username: id,
  title: null,
  joinedAt: id === "alice" ? "2026-02-01T12:00:00Z" : "2026-01-01T12:00:00Z",
  lastSeenAt: null,
  teamCount: 99,
})
const access: WorkspaceAccessSummary = {
  canManage: true,
  currentUserId: "alice",
  invitations: [],
  members: [
    member("alice", "Alice", "admin", true),
    member("bob", "Bob", "member"),
    member("cara", "Cara", "owner"),
  ],
}
const team: TeamDirectoryEntry = {
  id: "product",
  name: "Product",
  slug: "product",
  identifier: "PRO",
  icon: { kind: "icon", value: "UserGroup03Icon", color: "#818cf8" },
  timezone: "Europe/Paris",
  description: "",
  visibility: "workspace",
  estimationScheme: "none",
  issueEmailEnabled: false,
  detailedHistoryEnabled: false,
  createdAt: "2026-01-01T12:00:00Z",
  lifecycle: "active",
  isMember: true,
  memberCount: 1,
  memberPreviews: [],
  directoryMembers: [
    { id: "alice", name: "Alice", username: "alice", image: null },
  ],
  issueCount: null,
  recoverableUntil: null,
  capabilities: {
    canOpenSettings: true,
    canLeave: true,
    canDelete: true,
    canRestore: false,
  },
}
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
})
function start(data = access) {
  return render(<WorkspaceMembers access={data} teams={[team]} />)
}

describe("Workspace member directory", () => {
  it("uses real team membership, searches by email, and opens member details", () => {
    start()
    expect(screen.getByText("PRO")).toBeTruthy()
    expect(screen.queryByText("99")).toBeNull()
    fireEvent.change(screen.getByRole("textbox", { name: "Find members" }), {
      target: { value: "BOB@forge.test" },
    })
    expect(screen.getByRole("button", { name: "View Bob" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "View Alice" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }))
    fireEvent.click(screen.getByRole("button", { name: "View Alice" }))
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(
      screen.getByRole("link", { name: "Product" }).getAttribute("href")
    ).toBe("/teams/product/overview")
  })
  it("combines role, team, and activity filters and can clear them", () => {
    start()
    fireEvent.click(screen.getByRole("button", { name: "Add member filter" }))
    selectOption(
      screen.getByRole("combobox", { name: "Filter by role" }),
      "Admin"
    )
    selectOption(
      screen.getByRole("combobox", { name: "Filter by team" }),
      "Product"
    )
    selectOption(
      screen.getByRole("combobox", { name: "Filter by activity" }),
      "Online"
    )
    expect(screen.getByRole("button", { name: "View Alice" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "View Bob" })).toBeNull()
    selectOption(
      screen.getByRole("combobox", { name: "Filter by activity" }),
      "Offline"
    )
    expect(
      screen.getByRole("heading", { name: "No members found" })
    ).toBeTruthy()
    fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0])
    expect(screen.getByRole("button", { name: "View Bob" })).toBeTruthy()
  })
  it("sorts rows and hides optional columns through the shared display control", () => {
    start()
    fireEvent.click(screen.getByRole("button", { name: "Order by Name" }))
    expect(
      screen
        .getAllByRole("button", { name: /^View (Alice|Bob|Cara)$/ })
        .map((el) => el.textContent)
    ).toEqual([
      expect.stringContaining("Cara"),
      expect.stringContaining("Bob"),
      expect.stringContaining("Alice"),
    ])
    fireEvent.click(
      screen.getByRole("button", { name: "Member list display options" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Joined" }))
    expect(screen.queryByRole("columnheader", { name: /Joined/ })).toBeNull()
  })
  it("retains invitation input after errors and refreshes the directory on success", async () => {
    mocks.invite
      .mockResolvedValueOnce({ ok: false, message: "Already a member" })
      .mockResolvedValueOnce({ ok: true, delivery: { state: "queued" } })
    start()
    fireEvent.click(screen.getByRole("button", { name: "Invite members" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Email address" }), {
      target: { value: "new@forge.test" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }))
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Already a member"
    )
    expect(
      screen.getByRole("textbox", { name: "Email address" })
    ).toHaveProperty("value", "new@forge.test")
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }))
    await waitFor(() => expect(mocks.invalidate).toHaveBeenCalledOnce())
    expect(mocks.invite).toHaveBeenLastCalledWith({
      data: { email: "new@forge.test", role: "member" },
    })
    expect(screen.queryByRole("dialog")).toBeNull()
  })
  it("does not offer invitation controls to members without management permission", () => {
    start({ ...access, canManage: false })
    expect(screen.queryByRole("button", { name: "Invite members" })).toBeNull()
  })
})
