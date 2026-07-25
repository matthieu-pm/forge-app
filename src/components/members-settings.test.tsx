import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { MembersSettings } from "./members-settings"
import type { WorkspaceMemberSummary } from "@/lib/member-contract"

vi.mock("@/lib/member-state", () => ({
  inviteWorkspaceMember: vi.fn().mockResolvedValue({
    ok: true,
    invitation: {
      id: "invitation-1",
      email: "new@forge.app",
      role: "member",
    },
  }),
}))

const members: Array<WorkspaceMemberSummary> = [
  {
    id: "member-2",
    userId: "user-2",
    name: "Zoe Builder",
    email: "zoe@forge.app",
    image: null,
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
    role: "admin",
    joinedAt: "2025-03-23T10:00:00.000Z",
    lastSeenAt: "2026-07-25T10:00:00.000Z",
    teamCount: 2,
    isOnline: true,
  },
]

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe("MembersSettings", () => {
  it("groups members and applications using the shared table", () => {
    render(<MembersSettings members={members} />)

    expect(screen.getByText("Active")).toBeTruthy()
    expect(screen.getAllByText("Application")).toHaveLength(2)
    expect(screen.getByText("Ada Admin")).toBeTruthy()
    expect(screen.getByText("Factory")).toBeTruthy()
    expect(screen.getByText("Linear")).toBeTruthy()
  })

  it("searches members by name or email", () => {
    render(<MembersSettings members={members} />)

    fireEvent.change(
      screen.getByRole("textbox", {
        name: "Search members by name or email",
      }),
      { target: { value: "zoe@forge.app" } }
    )

    expect(screen.getByText("Zoe Builder")).toBeTruthy()
    expect(screen.queryByText("Ada Admin")).toBeNull()
    expect(screen.queryByText("Factory")).toBeNull()
  })

  it("uses the username saved from profile settings", async () => {
    window.localStorage.setItem(
      "forge:profile:user-1",
      JSON.stringify({ title: "Founder", username: "ada-updated" })
    )

    render(<MembersSettings members={members} />)

    expect(await screen.findByText("ada-updated")).toBeTruthy()
    expect(screen.queryByText("ada")).toBeNull()
  })

  it("sorts members from the table headers", () => {
    const { container } = render(<MembersSettings members={members} />)

    expect(container.textContent.indexOf("Ada Admin")).toBeLessThan(
      container.textContent.indexOf("Zoe Builder")
    )

    fireEvent.click(screen.getByRole("button", { name: "Order by Name" }))

    expect(container.textContent.indexOf("Zoe Builder")).toBeLessThan(
      container.textContent.indexOf("Ada Admin")
    )
  })

  it("opens the workspace invitation form", () => {
    render(<MembersSettings members={members} />)

    fireEvent.click(screen.getByRole("button", { name: "Invite" }))

    expect(
      screen.getByRole("heading", { name: "Invite a workspace member" })
    ).toBeTruthy()
    expect(screen.getByLabelText("Email address")).toBeTruthy()
    expect(screen.getByLabelText("Role")).toBeTruthy()
  })
})
