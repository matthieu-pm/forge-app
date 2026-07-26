import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { MembersSettings } from "./members-settings"
import type {
  WorkspaceAccessSummary,
  WorkspaceMemberSummary,
} from "@/lib/member-contract"

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: vi.fn().mockResolvedValue(undefined) }),
}))

const mocks = vi.hoisted(() => ({
  inviteWorkspaceMember: vi.fn(),
  manageWorkspaceAccess: vi.fn(),
  retryInvitationDelivery: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock("@/lib/member-state", () => ({
  inviteWorkspaceMember: mocks.inviteWorkspaceMember,
  manageWorkspaceAccess: mocks.manageWorkspaceAccess,
  retryInvitationDelivery: mocks.retryInvitationDelivery,
}))

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.inviteWorkspaceMember.mockResolvedValue({
    ok: true,
    invitation: {
      id: "invitation-1",
      email: "new@forge.app",
      role: "member",
      url: "http://localhost/accept-invitation?id=invitation-1",
    },
    delivery: { state: "sent-synchronously" },
  })
  mocks.manageWorkspaceAccess.mockResolvedValue({ ok: true })
  mocks.retryInvitationDelivery.mockResolvedValue({
    ok: true,
    state: "queued",
    businessRunId: "d07e1242-b665-4c43-974f-a9459a1c12e4",
  })
})

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

  it("shows the partial-success retry toaster after enqueue exhaustion", async () => {
    const businessRunId = "d07e1242-b665-4c43-974f-a9459a1c12e4"
    mocks.inviteWorkspaceMember.mockResolvedValue({
      ok: true,
      invitation: {
        id: "invitation-2",
        email: "new@forge.app",
        role: "member",
        url: "https://forge.test/accept-invitation?id=invitation-2",
      },
      delivery: { state: "failed-to-start", businessRunId },
    })
    render(<MembersSettings access={access} />)

    fireEvent.click(screen.getByRole("button", { name: "Invite" }))
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "new@forge.app" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }))

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Invitation created, delivery could not be queued",
        expect.objectContaining({
          action: expect.objectContaining({ label: "Retry" }),
        })
      )
    })

    const options = mocks.toastError.mock.calls.at(-1)?.[1]
    options.action.onClick()
    await waitFor(() => {
      expect(mocks.retryInvitationDelivery).toHaveBeenCalledWith({
        data: { businessRunId },
      })
    })
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Invitation created, delivery could not be queued",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Retrying…" }),
      })
    )
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
