import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { useState } from "react"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IntegrationsSettings } from "./integrations-settings"
import { ProjectUpdatesSettings } from "./project-updates-settings"
import { AgentTranscript } from "./agent/agent-transcript"
import { AgentComposer } from "./agent/agent-composer"
import type { FunctionComponent, ReactNode } from "react"
import type { TeamDirectoryEntry } from "@/lib/team-contract"
import type { AgentEvent } from "@/application/agents/event-contract"
import { WorkspaceTeams } from "@/routes/workspace/teams"
import { Route as RootRoute } from "@/routes/__root"

vi.mock("@/lib/team-state", () => ({
  loadTeamDirectory: vi.fn(),
  joinTeam: vi.fn(),
  leaveTeam: vi.fn(),
}))
vi.mock("@/lib/auth-state", () => ({ protectedRouteBeforeLoad: vi.fn() }))
vi.mock("@/components/custom-emoji-provider", () => ({
  WorkspaceEmojiProvider: ({ children }: { children: ReactNode }) => children,
  useCustomEmojis: () => ({ emojis: [] }),
}))
vi.mock("@/components/personal-preference-effects", () => ({
  PersonalPreferenceEffects: () => null,
}))
vi.mock("@/components/agent/agent-shell", () => ({ AgentShell: () => null }))
vi.mock("@/components/agent/agent-footer-actions", () => ({
  AgentFooterActions: () => null,
}))
vi.mock("@/components/desktop-title-bar", () => ({
  DesktopTitleBar: () => null,
}))
vi.mock("@/host/host-integration", () => ({ HostIntegration: () => null }))
vi.mock("@/components/agent/agent-provider", () => ({
  AgentProvider: ({ children }: { children: ReactNode }) => children,
  useAgent: () => ({
    surfaceMode: "hidden",
    draft: "",
    setDraft: vi.fn(),
    models: [],
    modelSelection: "auto",
    setModelSelection: vi.fn(),
    effort: "auto",
    setEffort: vi.fn(),
    sendMessage: vi.fn(),
    activeThreadId: null,
    runningThreadIds: new Set(),
    cancelActiveRun: vi.fn(),
    features: { agent_model_connections: true },
    attachments: [],
    uploadingAttachments: false,
    attachFiles: vi.fn(),
    removeAttachment: vi.fn(),
    error: null,
  }),
}))
vi.mock("@/components/app-sidebar", () => ({
  AppSidebar: () => {
    const [expanded, setExpanded] = useState(false)
    return (
      <aside>
        <button onClick={() => setExpanded(!expanded)}>
          {expanded ? "Teams expanded" : "Teams collapsed"}
        </button>
      </aside>
    )
  },
}))
vi.mock("@/components/settings-sidebar", () => ({
  SettingsSidebar: () => {
    const [query, setQuery] = useState("")
    return (
      <aside>
        <input
          aria-label="Settings search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </aside>
    )
  },
}))

const team: TeamDirectoryEntry = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "testing",
  identifier: "TES",
  name: "Testing",
  icon: { kind: "emoji", value: "🔥", color: "#818cf8" },
  timezone: "Europe/Paris",
  description: "",
  visibility: "workspace",
  estimationScheme: "none",
  issueEmailEnabled: false,
  detailedHistoryEnabled: false,
  createdAt: "2026-10-15T09:00:00.000Z",
  lifecycle: "active",
  isMember: true,
  memberCount: 1,
  memberPreviews: [
    { id: "member-1", name: "Tester", username: "tester", image: null },
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
  window.localStorage.clear()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  )
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal("scrollTo", vi.fn())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function mountPage(
  component: FunctionComponent,
  rootComponent: FunctionComponent = () => (
    <>
      <aside data-testid="persistent-sidebar" />
      <Outlet />
    </>
  )
) {
  const root = createRootRoute({ component: rootComponent })
  const source = createRoute({
    getParentRoute: () => root,
    path: "/inbox",
    component,
  })
  const destinations = [
    "/settings/applications",
    "/settings/ai",
    "/teams/$teamSlug/members",
    "/settings",
    "/settings/teams",
    "/settings/teams/$teamSlug",
  ].map((path) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => <h1>Destination</h1>,
    })
  )
  const router = createRouter({
    routeTree: root.addChildren([source, ...destinations]),
    history: createMemoryHistory({ initialEntries: ["/inbox"] }),
  })
  await act(async () => {
    render(<RouterProvider router={router} />)
    await router.load()
  })
  return router
}

async function followLink(
  label: string,
  expectedPath: string,
  router: Awaited<ReturnType<typeof mountPage>>
) {
  const sidebar = screen.getByTestId("persistent-sidebar")
  const link = await screen.findByRole("link", { name: label })
  // A router link prevents the browser's native document navigation.
  expect(fireEvent.click(link, { button: 0 })).toBe(false)
  await waitFor(() => expect(router.state.location.pathname).toBe(expectedPath))
  expect(
    await screen.findByRole("heading", { name: "Destination" })
  ).toBeTruthy()
  expect(screen.getByTestId("persistent-sidebar")).toBe(sidebar)
}

describe("internal navigation without document reloads", () => {
  it("routes the integration Manage link inside the existing shell", async () => {
    const router = await mountPage(IntegrationsSettings)
    fireEvent.click(
      screen.getAllByRole("button", { name: "View Slack integration" })[0]
    )
    await followLink("Manage", "/settings/applications", router)
  })
  it("routes the project update connection menu inside the existing shell", async () => {
    const router = await mountPage(() => (
      <ProjectUpdatesSettings workspaceId="workspace-1" />
    ))
    fireEvent.click(
      screen.getByRole("button", { name: "Open Slack connection menu" })
    )
    const item = await screen.findByRole("menuitem", {
      name: "Manage in Applications",
    })
    expect(fireEvent.click(item, { button: 0 })).toBe(false)
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/applications")
    )
  })
  it("routes team member avatars inside the existing shell", async () => {
    const router = await mountPage(() => (
      <WorkspaceTeams directory={{ canCreateTeam: true, items: [team] }} />
    ))
    await followLink("Manage Testing members", "/teams/testing/members", router)
  })
  it("routes internal assistant links while keeping external links and files separate", async () => {
    const events = [
      {
        id: "event-1",
        sourceEventId: "source-event-1",
        threadId: "thread-1",
        runId: "run-1",
        sequence: 1,
        occurredAt: "2026-10-15T09:00:00Z",
        source: "forge",
        type: "assistant.message",
        schemaVersion: 1,
        payload: {
          messageId: "message-1",
          content:
            "[Members](/teams/testing/members?invite=true#members) [Website](https://example.com) [CDN](//cdn.example.com/file) [Docs](/api/docs) [Bad](javascript:alert(1))",
        },
      },
    ] as Array<AgentEvent>
    const router = await mountPage(() => (
      <AgentTranscript
        events={events}
        running={false}
        onResolveApproval={vi.fn()}
        onRetry={vi.fn()}
      />
    ))
    expect(
      screen.getByRole("link", { name: "Website" }).getAttribute("target")
    ).toBe("_blank")
    expect(
      screen.getByRole("link", { name: "CDN" }).getAttribute("target")
    ).toBe("_blank")
    expect(
      screen.getByRole("link", { name: "Docs" }).getAttribute("href")
    ).toBe("/api/docs")
    expect(screen.queryByRole("link", { name: "Bad" })).toBeNull()
    await followLink("Members", "/teams/testing/members", router)
    expect(router.state.location.search).toEqual({ invite: true })
    expect(router.state.location.hash).toBe("members")
  })
  it("routes the composer provider settings without losing the shell", async () => {
    const router = await mountPage(AgentComposer)
    fireEvent.click(screen.getByRole("button", { name: /^Model / }))
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open model and effort settings",
      })
    )
    fireEvent.click(
      await screen.findByRole("button", { name: /Providers/ })
    )
    await waitFor(() =>
      expect(router.state.location.pathname).toBe("/settings/ai")
    )
    expect(screen.getByTestId("persistent-sidebar")).toBeTruthy()
  })
})

describe("app and settings sidebar state", () => {
  it("retains both sidebar instances and their local state across settings visits", async () => {
    const router = await mountPage(
      () => <h1>Inbox</h1>,
      RootRoute.options.component as FunctionComponent
    )
    fireEvent.click(screen.getByRole("button", { name: "Teams collapsed" }))
    const appButton = screen.getByRole("button", { name: "Teams expanded" })
    await act(async () => {
      await router.navigate({ href: "/settings" })
    })
    const search = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Settings search",
    })
    fireEvent.change(search, { target: { value: "Teams" } })
    await act(async () => {
      await router.navigate({ href: "/settings/teams" })
      await router.navigate({ href: "/settings/teams/testing" })
    })
    expect(screen.getByRole("textbox", { name: "Settings search" })).toBe(
      search
    )
    await act(async () => {
      await router.navigate({ href: "/inbox" })
    })
    expect(screen.getByRole("button", { name: "Teams expanded" })).toBe(
      appButton
    )
    await act(async () => {
      await router.navigate({ href: "/settings" })
    })
    expect(screen.getByRole("textbox", { name: "Settings search" })).toBe(
      search
    )
    expect(search.value).toBe("Teams")
  })
})
