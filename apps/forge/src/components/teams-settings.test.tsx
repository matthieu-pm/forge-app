import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TeamsSettings } from "./teams-settings"
import type { TeamSummary } from "@/lib/team-contract"

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
): TeamSummary {
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
    estimationScheme: "none",
    issueEmailEnabled: false,
    detailedHistoryEnabled: false,
    createdAt,
  }
}

describe("TeamsSettings", () => {
  const teams = [
    team("Beta", "BET", "2026-07-25T09:00:00.000Z"),
    team("Alpha", "ALP", "2025-03-23T09:00:00.000Z"),
  ]

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(cleanup)

  it("filters by team name or identifier", () => {
    render(<TeamsSettings teams={teams} />)

    const filter = screen.getByRole("textbox", {
      name: "Filter teams by name",
    })
    fireEvent.change(filter, { target: { value: "BET" } })

    expect(screen.getByText("Beta")).not.toBeNull()
    expect(screen.queryByText("Alpha")).toBeNull()
    expect(screen.getAllByText("1")).toHaveLength(2)
  })

  it("sorts by creation date using the table header controls", () => {
    const { container } = render(<TeamsSettings teams={teams} />)

    expect(container.textContent?.indexOf("Alpha")).toBeLessThan(
      container.textContent?.indexOf("Beta") ?? 0
    )

    fireEvent.click(screen.getByRole("button", { name: "Order by Created" }))

    expect(container.textContent?.indexOf("Alpha")).toBeLessThan(
      container.textContent?.indexOf("Beta") ?? 0
    )

    fireEvent.click(screen.getByRole("button", { name: "Order by Created" }))

    expect(container.textContent?.indexOf("Beta")).toBeLessThan(
      container.textContent?.indexOf("Alpha") ?? 0
    )
  })

  it("uses the full page width and initializes an empty workspace", () => {
    const { container } = render(<TeamsSettings teams={[]} />)
    const content = container.querySelector("main > div")
    const tableHeader = container.querySelector("thead")

    expect(screen.getByText("Atrium")).not.toBeNull()
    expect(screen.getByText("Forge")).not.toBeNull()
    expect(screen.getByText("77")).not.toBeNull()
    expect(screen.getByText("17")).not.toBeNull()
    expect(content?.className).toBe("w-full")
    expect(tableHeader?.className).toContain("[&_tr]:border-b-0")
  })

  it("offers settings, leave, and delete actions for each team", async () => {
    render(<TeamsSettings teams={[teams[0]]} />)

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
})
