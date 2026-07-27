import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { WorkspaceTeams } from "./teams"
import type { TeamDirectory, TeamDirectoryEntry } from "@/lib/team-contract"

const mocks = vi.hoisted(() => ({
  leaveTeam: vi.fn(),
  loadTeamDirectory: vi.fn(),
}))

vi.mock("@/lib/team-state", () => mocks)

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useLoaderData: vi.fn(),
  }),
  Link: ({
    children,
    params,
    search: _search,
    to,
    ...props
  }: React.ComponentProps<"a"> & {
    params?: Record<string, string>
    search?: Record<string, string>
    to: string
  }) => {
    let href = to
    for (const [key, value] of Object.entries(params ?? {})) {
      href = href.replace(`$${key}`, value)
    }

    return (
      <a href={href} {...props}>
        {children}
      </a>
    )
  },
  useRouter: () => ({
    invalidate: vi.fn(),
  }),
}))

function team(
  name: string,
  identifier: string,
  isMember: boolean,
  memberCount: number
): TeamDirectoryEntry {
  return {
    id:
      name === "Atrium"
        ? "00000000-0000-4000-8000-000000000001"
        : "00000000-0000-4000-8000-000000000002",
    slug: name.toLowerCase(),
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
    createdAt: "2026-07-27T09:00:00.000Z",
    lifecycle: "active",
    isMember,
    memberCount,
    memberPreviews: Array.from(
      { length: Math.min(memberCount, 5) },
      (_, index) => ({
        id: `user-${index + 1}`,
        name: index === 0 ? "Matthieu Duchatellier" : `Member ${index + 1}`,
        username: index === 0 ? "menade" : `member-${index + 1}`,
        image: null,
      })
    ),
    issueCount: null,
    recoverableUntil: null,
    capabilities: {
      canOpenSettings: true,
      canLeave: isMember,
      canDelete: true,
      canRestore: false,
    },
  }
}

const directory: TeamDirectory = {
  canCreateTeam: true,
  items: [team("Forge", "FOR", false, 1), team("Atrium", "ATM", true, 7)],
}

afterEach(cleanup)

describe("WorkspaceTeams", () => {
  it("renders the compact team directory with real membership data", () => {
    render(<WorkspaceTeams directory={directory} />)

    expect(screen.getByRole("heading", { name: "Teams" })).not.toBeNull()
    expect(screen.getByText("2 teams")).not.toBeNull()
    expect(
      screen.getByRole("columnheader", { name: "Membership" })
    ).not.toBeNull()
    const atriumLink = screen.getByRole("link", {
      name: "Open Atrium projects",
    })
    const atriumRow = atriumLink.closest("tr")
    const atriumCells = atriumRow?.querySelectorAll("td")
    const firstCell = atriumCells?.item(0)
    const lastCell = atriumCells
      ? atriumCells.item(atriumCells.length - 1)
      : undefined

    expect(atriumLink.getAttribute("href")).toBe("/teams/atrium/projects")
    expect(
      screen
        .getByRole("link", { name: "Manage Atrium members" })
        .getAttribute("href")
    ).toBe("/settings/teams/atrium/members")
    expect(
      screen
        .getByRole("link", { name: "Manage Atrium members" })
        .querySelectorAll("[data-member-avatar]")
    ).toHaveLength(5)
    expect(screen.getByText("+2")).not.toBeNull()
    expect(atriumRow?.className).toContain("h-10")
    for (const cellIndex of [1, 2, 3, 4]) {
      expect(
        atriumCells?.item(cellIndex).firstElementChild?.className
      ).toContain("h-10")
      expect(
        atriumCells?.item(cellIndex).firstElementChild?.className
      ).toContain("items-center")
    }
    expect(firstCell?.className).toContain("rounded-l-lg")
    expect(firstCell?.className).toContain("border-l-4")
    expect(firstCell?.className).toContain("pl-3")
    expect(lastCell?.className).toContain("rounded-r-lg")
    expect(lastCell?.className).toContain("border-r-4")
    expect(lastCell?.className).toContain("pr-0")
  })

  it("filters the list to teams the current user joined", () => {
    render(<WorkspaceTeams directory={directory} />)

    fireEvent.click(screen.getByRole("button", { name: "Filter teams" }))
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Joined teams" }))

    expect(screen.getByText("1 team")).not.toBeNull()
    expect(screen.getByText("Atrium")).not.toBeNull()
    expect(screen.queryByText("Forge")).toBeNull()
  })

  it("shows a member identity tooltip when an avatar is hovered", async () => {
    render(<WorkspaceTeams directory={directory} />)

    const avatar = screen
      .getByRole("link", { name: "Manage Atrium members" })
      .querySelector("[data-member-avatar='user-1']")

    expect(avatar).not.toBeNull()
    fireEvent.focus(avatar as Element)

    expect(
      await screen.findByText("Matthieu Duchatellier (menade)")
    ).not.toBeNull()
  })

  it("exposes the reference team actions in the row menu", () => {
    render(<WorkspaceTeams directory={directory} />)

    fireEvent.click(screen.getByRole("button", { name: "Open Atrium menu" }))

    expect(screen.getByRole("menuitem", { name: "Favorite" })).not.toBeNull()
    expect(
      screen.getByRole("menuitem", { name: "Team settings" })
    ).not.toBeNull()
    expect(screen.getByRole("menuitem", { name: "Copy URL" })).not.toBeNull()
    expect(
      screen.getByRole("menuitem", { name: "Open archive" })
    ).not.toBeNull()
    expect(screen.getByRole("menuitem", { name: "Subscribe" })).not.toBeNull()
    expect(
      screen.getByRole("menuitem", {
        name: "Configure Slack notifications…",
      })
    ).not.toBeNull()
    expect(screen.getByRole("menuitem", { name: "Leave team…" })).not.toBeNull()
  })
})
