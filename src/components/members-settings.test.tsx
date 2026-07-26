import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { MembersSettings } from "./members-settings"
import type {
  WorkspaceAccessSummary,
  WorkspaceMemberSummary,
} from "@/lib/member-contract"

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: vi.fn().mockResolvedValue(undefined) }),
}))

vi.mock("@/lib/member-state", () => ({
  inviteWorkspaceMember: vi.fn().mockResolvedValue({
    ok: true,
    invitation: {
      id: "invitation-1",
      email: "new@forge.app",
      role: "member",
      url: "http://localhost/accept-invitation?id=invitation-1",
    },
  }),
  manageWorkspaceAccess: vi.fn().mockResolvedValue({ ok: true }),
}))

const members: Array<WorkspaceMemberSummary> = [
  {
    id: "member-2",
    userId: "user-2",
    name: "Zoe Builder",
    email: "zoe@forge.app",
    image: null,
    username: "zoe",
    title: null,
    role: "member",
    joinedAt: "2026-07-20T10:00:00.000Z",
    lastSeenAt: "2026-07-24T10:00:00.000Z",
    teamCount: 1,
    isOnline: false,
  },
  {
    id: "member-1",
    userId: "user-1",
    name: "Ada Admin",
    email: "ada@forge.app",
    image: null,
    username: "ada-updated",
    title: "Founder",
    role: "admin",
    joinedAt: "2025-03-23T10:00:00.000Z",
    lastSeenAt: "2026-07-25T10:00:00.000Z",
    teamCount: 2,
    isOnline: true,
  },
]

const access: WorkspaceAccessSummary = {
  members,
  invitations: [
    {
      id: "invitation-1",
      email: "invited@forge.app",
      role: "member",
      createdAt: "2026-07-25T10:00:00.000Z",
      expiresAt: "2026-07-27T10:00:00.000Z",
      expired: false,
    },
  ],
  currentUserId: "user-1",
  canManage: true,
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe("MembersSettings", () => {
  it("groups active members and pending invitations using the shared table", () => {
    render(<MembersSettings access={access} />)

    expect(screen.getByText("Active")).toBeTruthy()
    expect(screen.getAllByText("Invited")).toHaveLength(2)
    expect(screen.getByText("Ada Admin")).toBeTruthy()
    expect(screen.getAllByText("invited@forge.app")).toHaveLength(2)
    expect(screen.queryByText("Factory")).toBeNull()
    expect(screen.queryByText("Linear")).toBeNull()
  })

  it("searches members by name or email", () => {
    render(<MembersSettings access={access} />)

    fireEvent.change(
      screen.getByRole("textbox", {
        name: "Search members by name or email",
      }),
      { target: { value: "zoe@forge.app" } }
    )

    expect(screen.getByText("Zoe Builder")).toBeTruthy()
    expect(screen.queryByText("Ada Admin")).toBeNull()
    expect(screen.queryByText("invited@forge.app")).toBeNull()
  })

  it("uses the persisted profile username", () => {
    render(<MembersSettings access={access} />)

    expect(screen.getByText("ada-updated")).toBeTruthy()
    expect(screen.queryByText("ada")).toBeNull()
  })

  it("sorts members from the table headers", () => {
    const { container } = render(
      <MembersSettings access={{ ...access, invitations: [] }} />
    )

    expect(container.textContent.indexOf("Ada Admin")).toBeLessThan(
      container.textContent.indexOf("Zoe Builder")
    )

    fireEvent.click(screen.getByRole("button", { name: "Order by Name" }))

    expect(container.textContent.indexOf("Zoe Builder")).toBeLessThan(
      container.textContent.indexOf("Ada Admin")
    )
  })

  it("opens the workspace invitation form for managers", () => {
    render(<MembersSettings access={access} />)

    fireEvent.click(screen.getByRole("button", { name: "Invite" }))

    expect(
      screen.getByRole("heading", { name: "Invite a workspace member" })
    ).toBeTruthy()
    expect(screen.getByLabelText("Email address")).toBeTruthy()
    expect(screen.getByLabelText("Role")).toBeTruthy()
  })

  it("hides management controls from regular members", () => {
    render(<MembersSettings access={{ ...access, canManage: false }} />)

    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull()
    expect(
      screen.queryByRole("button", {
        name: "Open invited@forge.app invitation menu",
      })
    ).toBeNull()
  })
})
