import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TeamsSettings } from "./teams-settings"
import type { TeamDirectory, TeamDirectoryEntry } from "@/lib/team-contract"

const mocks = vi.hoisted(() => ({
  deleteTeam: vi.fn(),
  leaveTeam: vi.fn(),
  restoreTeam: vi.fn(),
}))

vi.mock("@/lib/team-state", () => mocks)

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    to,
    ...props
  }: React.ComponentProps<"a"> & {
    params?: { teamSlug?: string }
    to: string
  }) => (
    <a href={to.replace("$teamSlug", params?.teamSlug ?? "")} {...props}>
      {children}
    </a>
  ),
  useRouter: () => ({
    invalidate: vi.fn(),
  }),
}))

function team(
  name: string,
  identifier: string,
  createdAt: string
): TeamDirectoryEntry {
  return {
    id:
      name === "Alpha"
        ? "00000000-0000-4000-8000-000000000001"
        : "00000000-0000-4000-8000-000000000002",
    slug: name.toLocaleLowerCase(),
    identifier,
    name,
    icon: {
      kind: "icon",
      value: "UserGroup03Icon",
      color: "#818cf8",
    },
    timezone: "Europe/Paris",
    description: "",
    visibility: "workspace",
    estimationScheme: "none",
    issueEmailEnabled: false,
    detailedHistoryEnabled: false,
    createdAt,
    lifecycle: "active",
    isMember: true,
    memberCount: 2,
    memberPreviews: [
      {
        id: "user-1",
        name: "Ada Lovelace",
        username: "ada",
        image: null,
      },
      {
        id: "user-2",
        name: "Grace Hopper",
        username: "grace",
        image: null,
      },
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
}

describe("TeamsSettings", () => {
  const teams = [
    team("Beta", "BET", "2026-07-25T09:00:00.000Z"),
    team("Alpha", "ALP", "2025-03-23T09:00:00.000Z"),
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.restoreTeam.mockResolvedValue({ ok: true, team: teams[0] })
  })

  afterEach(cleanup)

  function directory(
    items: Array<TeamDirectoryEntry>,
    canCreateTeam = true
  ): TeamDirectory {
    return { items, canCreateTeam }
  }

  it("filters by team name or identifier", () => {
    render(
      <TeamsSettings
        directory={directory(teams)}
        status="active"
        onStatusChange={vi.fn()}
      />
    )

    const filter = screen.getByRole("textbox", {
      name: "Filter teams by name",
    })
    fireEvent.change(filter, { target: { value: "BET" } })

    expect(screen.getByText("Beta")).not.toBeNull()
    expect(screen.queryByText("Alpha")).toBeNull()
    expect(screen.getAllByText("2")).toHaveLength(1)
  })

  it("sorts by creation date using the table header controls", () => {
    const { container } = render(
      <TeamsSettings
        directory={directory(teams)}
        status="active"
        onStatusChange={vi.fn()}
      />
    )

    expect(container.textContent.indexOf("Alpha")).toBeLessThan(
      container.textContent.indexOf("Beta")
    )

    fireEvent.click(screen.getByRole("button", { name: "Order by Created" }))

    expect(container.textContent.indexOf("Alpha")).toBeLessThan(
      container.textContent.indexOf("Beta")
    )

    fireEvent.click(screen.getByRole("button", { name: "Order by Created" }))

    expect(container.textContent.indexOf("Beta")).toBeLessThan(
      container.textContent.indexOf("Alpha")
    )
  })

  it("uses the full page width and initializes an empty workspace", () => {
    const { container } = render(
      <TeamsSettings
        directory={directory([])}
        status="active"
        onStatusChange={vi.fn()}
      />
    )
    const content = container.querySelector("main > div")
    const tableHeader = container.querySelector("thead")

    expect(screen.getByText("No teams yet")).not.toBeNull()
    expect(screen.queryByText("Atrium")).toBeNull()
    expect(screen.queryByText("Forge")).toBeNull()
    expect(screen.getAllByRole("button", { name: "Create team" })).toHaveLength(
      2
    )
    expect(content?.className).toBe("w-full")
    expect(tableHeader?.className).toContain("[&_tr]:border-b-0")
  })

  it("offers settings, leave, and delete actions for each team", async () => {
    render(
      <TeamsSettings
        directory={directory([teams[0]])}
        status="active"
        onStatusChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Open Beta menu" }))

    expect(
      await screen.findByRole("menuitem", { name: "Open team settings" })
    ).not.toBeNull()
    expect(screen.getByRole("menuitem", { name: "Leave team" })).not.toBeNull()

    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }))

    expect(
      await screen.findByRole("heading", { name: "Delete Beta?" })
    ).not.toBeNull()
  })

  it("offers restore for archived teams and hides management actions", async () => {
    const archivedTeam: TeamDirectoryEntry = {
      ...teams[0],
      lifecycle: "archived",
      recoverableUntil: "2026-08-24T09:00:00.000Z",
      capabilities: {
        canOpenSettings: false,
        canLeave: false,
        canDelete: false,
        canRestore: true,
      },
    }
    render(
      <TeamsSettings
        directory={directory([archivedTeam])}
        status="archived"
        onStatusChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Open Beta menu" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restore" }))

    expect(mocks.restoreTeam).toHaveBeenCalledWith({
      data: { slug: "beta" },
    })
    expect(
      screen.queryByRole("menuitem", { name: "Open team settings" })
    ).toBeNull()
  })

  it("hides team creation when the actor lacks permission", () => {
    render(
      <TeamsSettings
        directory={directory([], false)}
        status="active"
        onStatusChange={vi.fn()}
      />
    )

    expect(screen.queryByRole("button", { name: "Create team" })).toBeNull()
  })
})
