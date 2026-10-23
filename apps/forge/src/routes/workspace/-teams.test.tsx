import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { WorkspaceTeams } from "./teams"
import type { TeamDirectory, TeamDirectoryEntry } from "@/lib/team-contract"
import { selectOption } from "@/test-utils/select-option"
import { matchesTeamFilters } from "@/components/team-directory-controls"

const mocks = vi.hoisted(() => ({
  leaveTeam: vi.fn(),
  joinTeam: vi.fn(),
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
      name: "Open Atrium overview",
    })
    expect(atriumLink.getAttribute("href")).toBe("/teams/atrium/overview")
    expect(
      screen
        .getByRole("link", { name: "Manage Atrium members" })
        .getAttribute("href")
    ).toBe("/teams/atrium/members")
    expect(
      screen
        .getByRole("link", { name: "Manage Atrium members" })
        .querySelectorAll("[data-member-avatar]")
    ).toHaveLength(5)
    expect(screen.getByText("+2")).not.toBeNull()
    expect(
      screen.getByRole("columnheader", { name: "Description" })
    ).not.toBeNull()
    expect(screen.getByRole("columnheader", { name: "Cycle" })).not.toBeNull()
    expect(
      screen
        .getByRole("link", { name: "Open Atrium active projects" })
        .getAttribute("href")
    ).toBe("/teams/atrium/projects")
  })

  it("filters the list to teams the current user joined", async () => {
    render(<WorkspaceTeams directory={directory} />)

    fireEvent.click(screen.getByRole("button", { name: "Filter teams" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Members" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Current user" })
    )

    expect(screen.getByText("1 team")).not.toBeNull()
    expect(screen.getByText("Atrium")).not.toBeNull()
    expect(screen.queryByText("Forge")).toBeNull()
  })

  it("searches by identifier and description, combines membership, and clears search", async () => {
    render(
      <WorkspaceTeams
        directory={{
          ...directory,
          items: directory.items.map((item) => ({
            ...item,
            description: item.name === "Forge" ? "Product engineering" : "",
          })),
        }}
      />
    )
    const input = screen.getByRole("textbox", { name: "Find teams" })
    fireEvent.change(input, { target: { value: "  atm  " } })
    expect(screen.getByText("Atrium")).not.toBeNull()
    expect(screen.queryByText("Forge")).toBeNull()
    fireEvent.change(input, { target: { value: "engineering" } })
    expect(screen.getByText("Forge")).not.toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Filter teams" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Members" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Current user" })
    )
    expect(screen.getByText("No teams found")).not.toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }))
    expect(screen.getByText("Atrium")).not.toBeNull()
  })

  it("reverses name ordering without mutating the directory", () => {
    render(<WorkspaceTeams directory={directory} />)
    const nameLinks = () =>
      screen
        .getAllByRole("link", { name: /^Open (Atrium|Forge) overview$/ })
        .map((link) => link.textContent)
    expect(nameLinks()[0]).toContain("Atrium")
    fireEvent.click(screen.getByRole("button", { name: "Order by Name" }))
    expect(nameLinks()[0]).toContain("Forge")
    expect(
      screen
        .getByRole("columnheader", { name: "Name" })
        .getAttribute("aria-sort")
    ).toBe("descending")
    expect(directory.items[0].name).toBe("Forge")
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
  it("changes columns and reverses member ordering from display options", () => {
    render(<WorkspaceTeams directory={directory} />)
    fireEvent.click(
      screen.getByRole("button", { name: "Team list display options" })
    )
    for (const name of ["ID", "Membership", "Projects"])
      fireEvent.click(screen.getByRole("button", { name }))
    expect(screen.queryByText("ATM")).toBeNull()
    expect(
      screen.queryByRole("columnheader", { name: "Membership" })
    ).toBeNull()
    expect(
      screen.queryByRole("link", { name: "Open Atrium active projects" })
    ).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Owners" }))
    expect(screen.getByRole("columnheader", { name: "Owners" })).not.toBeNull()
    selectOption(screen.getByRole("combobox", { name: "View ordering" }), "Members")
    const rows = () =>
      screen.getAllByRole("link", { name: /^Open (Atrium|Forge) overview$/ })
    expect(rows()[0].textContent).toContain("Forge")
    fireEvent.click(screen.getByRole("button", { name: "Direction" }))
    expect(rows()[0].textContent).toContain("Atrium")
  })

  it("joins a team through its row menu", async () => {
    mocks.joinTeam.mockResolvedValue({
      ok: true,
      team: { name: "Forge", slug: "forge" },
    })
    render(<WorkspaceTeams directory={directory} />)
    fireEvent.click(screen.getByRole("button", { name: "Open Forge menu" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Join team" }))
    await waitFor(() =>
      expect(mocks.joinTeam).toHaveBeenCalledWith({ data: { slug: "forge" } })
    )
  })
  it("applies advanced filters only on confirmation and clears them from the toolbar", async () => {
    render(<WorkspaceTeams directory={directory} />)
    fireEvent.click(screen.getByRole("button", { name: "Filter teams" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Advanced filter" }))
    const value = await screen.findByRole("textbox", { name: "Filter value" })
    fireEvent.change(value, { target: { value: "forge" } })
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }))
    expect(
      screen.queryByRole("link", { name: "Open Atrium overview" })
    ).toBeNull()
    expect(
      screen.getByRole("link", { name: "Open Forge overview" })
    ).not.toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(
      screen.getByRole("link", { name: "Open Atrium overview" })
    ).not.toBeNull()
  })

  it("matches full member lists, owners, visibility and creation dates with all/any logic", () => {
    const entry = {
      ...directory.items[0],
      visibility: "private" as const,
      directoryMembers: [
        ...directory.items[0].memberPreviews,
        { id: "hidden-member", name: "Zoe", username: "zoe", image: null },
      ],
      owners: [{ id: "lead", name: "Ada", username: "ada", image: null }],
    }
    const rules = [
      {
        id: "a",
        field: "members" as const,
        operator: "is" as const,
        value: "hidden-member",
      },
      {
        id: "b",
        field: "owners" as const,
        operator: "is" as const,
        value: "lead",
      },
      {
        id: "c",
        field: "private" as const,
        operator: "is" as const,
        value: "true",
      },
      {
        id: "d",
        field: "created" as const,
        operator: "before" as const,
        value: "2026-08-01",
      },
    ]
    expect(matchesTeamFilters(entry, { match: "all", rules })).toBe(true)
    const wrongMember = { ...rules[0], value: "missing" }
    expect(
      matchesTeamFilters(entry, {
        match: "all",
        rules: [...rules, wrongMember],
      })
    ).toBe(false)
    expect(
      matchesTeamFilters(entry, {
        match: "any",
        rules: [wrongMember, rules[1]],
      })
    ).toBe(true)
    expect(
      matchesTeamFilters(entry, {
        match: "all",
        rules: [{ ...wrongMember, operator: "isNot" }],
      })
    ).toBe(true)
  })
})
