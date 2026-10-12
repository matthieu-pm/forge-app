import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, describe, expect, it, vi } from "vitest"

import { TeamSettingsOverview } from "./team-settings-overview"
import { TeamWorkflowsSettings } from "./team-workflows-settings"
import { TeamIssueStatusesSettings } from "./team-issue-statuses-settings"
import type { TeamSummary } from "@/lib/team-contract"

vi.mock("@/lib/team-state", () => ({ deleteTeam: vi.fn() }))

const team: TeamSummary = {
  id: "statuses-navigation-team",
  slug: "platform-api",
  identifier: "PLT",
  name: "Platform API",
  icon: { kind: "emoji", value: "🔥", color: "#94a3b8" },
  timezone: "Europe/Paris",
  description: "",
  visibility: "workspace",
  estimationScheme: "none",
  issueEmailEnabled: false,
  detailedHistoryEnabled: false,
  createdAt: "2026-10-12T10:00:00Z",
}

afterEach(cleanup)

describe("team settings workflow navigation", () => {
  it.each([
    ["statuses", "Issue statuses"],
    ["workflows", "Workflows & automations"],
  ])(
    "opens %s for the current team from the overview",
    async (section, title) => {
      vi.spyOn(window, "scrollTo").mockImplementation(() => {})
      const root = createRootRoute()
      const overview = createRoute({
        getParentRoute: () => root,
        path: "/settings/teams/$teamSlug",
        component: () => <TeamSettingsOverview team={team} memberCount={1} />,
      })
      const statuses = createRoute({
        getParentRoute: () => root,
        path: `/settings/teams/$teamSlug/${section}`,
        component: () =>
          section === "statuses" ? (
            <TeamIssueStatusesSettings team={team} />
          ) : (
            <TeamWorkflowsSettings team={team} />
          ),
      })
      const router = createRouter({
        routeTree: root.addChildren([overview, statuses]),
        history: createMemoryHistory({
          initialEntries: ["/settings/teams/platform-api"],
        }),
      })
      render(<RouterProvider router={router} />)

      const link = await screen.findByRole("link", { name: new RegExp(title) })
      expect(link.getAttribute("href")).toBe(
        `/settings/teams/platform-api/${section}`
      )
      fireEvent.click(link)

      await screen.findByRole("heading", { name: title })
      await waitFor(() =>
        expect(router.state.location.pathname).toBe(
          `/settings/teams/platform-api/${section}`
        )
      )
      expect(
        screen.getByRole("link", { name: "Back to Platform API settings" })
      ).toBeTruthy()
    }
  )
})
