import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { ComponentType, ReactNode } from "react"
import { Route } from "@/routes/__root"

const fixture = vi.hoisted(() => ({
  state: {
    location: { pathname: "/inbox" },
    resolvedLocation: { pathname: "/inbox" },
    matches: [{ pathname: "/inbox" }],
  },
  identity: { userId: "alice", sessionId: "session" } as {
    userId: string
    sessionId: string
  } | null,
}))

vi.mock("@/components/agent/agent-provider", async () => {
  const { createContext, useContext } = await import("react")
  const Context = createContext<object | null>(null)
  return {
    AgentProvider: ({ children }: { children: ReactNode }) => (
      <Context.Provider value={{ surfaceMode: "sidebar" }}>
        {children}
      </Context.Provider>
    ),
    useAgent: () => {
      const value = useContext(Context)
      if (!value) throw new Error("useAgent must be used within AgentProvider.")
      return value
    },
  }
})
vi.mock("@tanstack/react-router", async () => {
  const { useAgent } = await import("@/components/agent/agent-provider")
  function ProtectedPage() {
    useAgent()
    return <p>Protected page</p>
  }
  return {
    createRootRoute: (options: object) => ({ options }),
    useRouterState: ({
      select,
    }: {
      select: (state: typeof fixture.state) => unknown
    }) => select(fixture.state),
    Outlet: () => {
      const path = fixture.state.matches.at(-1)?.pathname
      return path === "/login" ? (
        <p>Login page</p>
      ) : path === "/" ? (
        <p>Startup redirect</p>
      ) : (
        <ProtectedPage />
      )
    },
    Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
    HeadContent: () => null,
    Scripts: () => null,
  }
})
vi.mock("@/components/account-preference-provider", () => ({
  useProtectedIdentity: () => fixture.identity,
  AccountPreferenceProvider: ({ children }: { children: ReactNode }) =>
    children,
  PreferenceSyncStatus: () => null,
}))
vi.mock("@/components/feature-availability", () => ({
  FeatureAvailabilityProvider: ({ children }: { children: ReactNode }) =>
    children,
}))
vi.mock("@/components/person-name-provider", () => ({
  PersonNameProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("@/components/issue-definition-provider", () => ({
  IssueDefinitionProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("@/components/custom-emoji-provider", () => ({
  WorkspaceEmojiProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
  SidebarInset: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock("@/components/app-sidebar", () => ({
  AppSidebar: () => <nav aria-label="App sidebar" />,
}))
vi.mock("@/components/settings-sidebar", () => ({
  SettingsSidebar: () => <nav aria-label="Settings sidebar" />,
}))
vi.mock("@/components/agent/agent-shell", () => ({ AgentShell: () => null }))
vi.mock("@/components/agent/agent-footer-actions", () => ({
  AgentFooterActions: () => null,
}))

const Layout = Route.options.component as ComponentType
beforeEach(() => {
  fixture.identity = { userId: "alice", sessionId: "session" }
})
afterEach(cleanup)

it("keeps the resolved protected child inside its providers while login is pending", () => {
  fixture.state = {
    location: { pathname: "/login" },
    resolvedLocation: { pathname: "/inbox" },
    matches: [{ pathname: "/inbox" }],
  }
  render(<Layout />)
  expect(screen.getByText("Protected page")).toBeTruthy()
  expect(screen.getByTestId("app-shell")).toBeTruthy()
})
it("provides the newly published protected match before resolvedLocation catches up", () => {
  fixture.state = {
    location: { pathname: "/inbox" },
    resolvedLocation: { pathname: "/login" },
    matches: [{ pathname: "/inbox" }],
  }
  render(<Layout />)
  expect(screen.getByText("Protected page")).toBeTruthy()
})
it("keeps startup shellless until the default-home match publishes", () => {
  fixture.state = {
    location: { pathname: "/inbox" },
    resolvedLocation: { pathname: "/" },
    matches: [{ pathname: "/" }],
  }
  render(<Layout />)
  expect(screen.getByText("Startup redirect")).toBeTruthy()
  expect(screen.queryByTestId("app-shell")).toBeNull()
})
it("provides the default-home child while resolvedLocation still points at startup", () => {
  fixture.state = {
    location: { pathname: "/inbox" },
    resolvedLocation: { pathname: "/" },
    matches: [{ pathname: "/inbox" }],
  }
  render(<Layout />)
  expect(screen.getByText("Protected page")).toBeTruthy()
})
it("renders the public matched page after publication without retaining the app shell", () => {
  fixture.state = {
    location: { pathname: "/login" },
    resolvedLocation: { pathname: "/inbox" },
    matches: [{ pathname: "/login" }],
  }
  render(<Layout />)
  expect(screen.getByText("Login page")).toBeTruthy()
  expect(screen.queryByTestId("app-shell")).toBeNull()
})
it("withholds the old protected child after identity retirement during sign-out", () => {
  fixture.identity = null
  fixture.state = {
    location: { pathname: "/login" },
    resolvedLocation: { pathname: "/inbox" },
    matches: [{ pathname: "/inbox" }],
  }
  render(<Layout />)
  expect(screen.getByRole("status").textContent).toContain(
    "Verifying your session"
  )
  expect(screen.queryByText("Protected page")).toBeNull()
})
