import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { AppSidebar } from "./app-sidebar"
import { SidebarCustomization } from "./sidebar-customization"
import { SidebarProvider } from "./ui/sidebar"
import {
  PreferenceFixtureScope,
  externalPreferenceEdit,
  renderPreferences,
  setupPreferenceFixture,
} from "@/test/preference-fixture"

const policy = vi.hoisted(() => ({ reviews: true }))
vi.mock("./feature-availability", () => ({
  useFeatureNavigation: () => (path: string) =>
    path !== "/reviews" || policy.reviews,
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, ...props }: { to: string }) => <a href={to} {...props} />,
  useRouter: () => ({ invalidate: vi.fn(), navigate: vi.fn() }),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: "/inbox" }, matches: [] }),
}))
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: {
        session: { id: "session", activeOrganizationId: "workspace" },
        user: { id: "alice" },
      },
    }),
    organization: { list: () => Promise.resolve({ data: [] }) },
  },
}))
vi.mock("@/lib/auth-state", () => ({
  getNavigationAuthState: () =>
    Promise.resolve({
      workspace: { id: "workspace", name: "Workspace", slug: "workspace" },
    }),
}))
vi.mock("@/lib/team-state", () => ({ listTeams: () => Promise.resolve([]) }))
vi.mock("@/lib/team-triage", () => ({ useEnabledTeamTriage: () => new Set() }))
vi.mock("@/lib/team-cycles", () => ({ useEnabledTeamCycles: () => new Set() }))
vi.mock("@/components/views/view-favorites", () => ({
  ViewFavorites: () => null,
}))
vi.mock("@/components/issues/sidebar-issue-button", () => ({
  SidebarIssueButton: () => null,
}))
vi.mock("@/components/getting-started-checklist", () => ({
  GettingStartedChecklist: () => null,
}))
afterEach(cleanup)
beforeEach(async () => {
  policy.reviews = true
  await setupPreferenceFixture()
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  })
})
function Fixture() {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarCustomization />
    </SidebarProvider>
  )
}

it("updates the mounted AppSidebar without reload and keeps Settings reachable after all optional destinations are hidden", async () => {
  renderPreferences(<Fixture />)
  await screen.findByRole("link", { name: "Forge" })
  await act(() =>
    externalPreferenceEdit("alice", {
      "general.sidebarLayout": [
        { id: "my-issues", visible: true },
        { id: "forge", visible: false },
      ],
    })
  )
  expect(screen.queryByRole("link", { name: "Forge" })).toBeNull()
  const links = screen.getAllByRole("link")
  expect(links[0].textContent).toBe("My issues")
  await act(() =>
    externalPreferenceEdit("alice", {
      "general.sidebarLayout": ["forge", "signals", "reviews", "my-issues"].map(
        (id) => ({ id, visible: false })
      ),
    })
  )
  const workspaceMenu = document.querySelector(
    '[data-sidebar="header"] button[aria-haspopup="menu"]'
  )
  expect(workspaceMenu).toBeTruthy()
  fireEvent.click(workspaceMenu!)
  await screen.findByRole("menuitem", { name: "Settings" })
})

it("cannot restore a saved feature-disabled destination and omits an empty Workspace group", async () => {
  const page = renderPreferences(<Fixture />)
  expect(screen.getByRole("link", { name: "Reviews" })).toBeTruthy()
  policy.reviews = false
  page.rerender(
    <PreferenceFixtureScope>
      <Fixture />
    </PreferenceFixtureScope>
  )
  expect(screen.queryByRole("link", { name: "Reviews" })).toBeNull()
  await act(() =>
    externalPreferenceEdit("alice", {
      "general.sidebarLayout": [
        "initiatives",
        "projects",
        "documents",
        "calls",
        "views",
        "teams",
        "members",
      ].map((id) => ({ id: `workspace-${id}`, visible: false })),
    })
  )
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull()
  )
  expect(screen.getByRole("link", { name: "Inbox" })).toBeTruthy()
})
