import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DesktopTitleBar } from "./desktop-title-bar"
import { createDesktopTabs } from "@/lib/desktop-tabs"
import { retireProtectedSession } from "@/lib/protected-session"

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  subscribe: vi.fn(),
  home: vi.fn(),
  storage: new Map<string, string>(),
  location: { pathname: "/my-issues", href: "/my-issues?view=assigned#issue" },
}))
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    navigate: mocks.navigate,
    get latestLocation() {
      return mocks.location
    },
  }),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({
      location: mocks.location,
      resolvedLocation: mocks.location,
      matches: [],
    }),
}))
vi.mock("@/components/account-preference-provider", () => ({
  useProtectedIdentity: () => ({ workspaceId: "w" }),
}))
vi.mock("@/lib/team-state", () => ({ listTeams: () => Promise.resolve([]) }))
vi.mock("@/lib/default-home-state", () => ({ loadDefaultHome: mocks.home }))
vi.mock("@/lib/product-storage", () => ({
  productStorage: {
    getItem: (key: string) => mocks.storage.get(key) ?? null,
    setItem: (key: string, value: string) => mocks.storage.set(key, value),
  },
}))
vi.mock("@/host/forge-host", () => ({
  getForgeHost: () => ({ subscribe: mocks.subscribe }),
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.storage.clear()
  mocks.location = {
    pathname: "/my-issues",
    href: "/my-issues?view=assigned#issue",
  }
  mocks.subscribe.mockReturnValue(() => {})
  mocks.home.mockResolvedValue("/inbox")
  Object.defineProperty(window, "forgeDesktop", {
    configurable: true,
    value: {},
  })
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, "forgeDesktop")
})

describe("FOR-131 desktop renderer default opens (fixture bridge)", () => {
  it.each(["/forge", "/inbox", "/my-issues"])(
    "AT-01 opens %s from both the button and native command without a placeholder history entry",
    async (path) => {
      mocks.home.mockResolvedValue(path)
      render(<DesktopTitleBar />)
      await act(() => Promise.resolve())
      fireEvent.click(screen.getByRole("button", { name: "New tab" }))
      await act(() => Promise.resolve())
      expect(mocks.navigate).toHaveBeenLastCalledWith({ href: path })
      const callback = mocks.subscribe.mock.calls.at(-1)![0]
      act(() => callback({ type: "command", command: "new-tab" }))
      await act(() => Promise.resolve())
      expect(mocks.navigate).toHaveBeenCalledTimes(2)
      expect(mocks.navigate).toHaveBeenLastCalledWith({ href: path })
      expect(mocks.home).toHaveBeenCalledTimes(2)
      const saved = JSON.parse(mocks.storage.get("forge:desktop-tabs")!)
      expect(saved.tabs.at(-1).history).toEqual([path])
    }
  )
  it("preserves every overlapping native new-tab request", async () => {
    let resolve!: (path: string) => void
    mocks.home.mockReturnValue(
      new Promise<string>((done) => {
        resolve = done
      })
    )
    render(<DesktopTitleBar />)
    await act(() => Promise.resolve())
    const callback = mocks.subscribe.mock.calls.at(-1)![0]
    act(() => {
      callback({ type: "command", command: "new-tab" })
      callback({ type: "command", command: "new-tab" })
    })
    await act(() => {
      resolve("/inbox")
      return Promise.resolve()
    })
    const saved = JSON.parse(mocks.storage.get("forge:desktop-tabs")!)
    expect(saved.tabs).toHaveLength(3)
    expect(
      saved.tabs.slice(1).map((tab: { history: Array<string> }) => tab.history)
    ).toEqual([["/inbox"], ["/inbox"]])
    expect(mocks.home).toHaveBeenCalledOnce()
    expect(mocks.navigate).toHaveBeenCalledOnce()
  })
  it("starts a fresh default batch after navigation while a previous request is pending", async () => {
    const resolvers: Array<(path: string) => void> = []
    mocks.home.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve)
        })
    )
    render(<DesktopTitleBar />)
    await act(() => Promise.resolve())
    fireEvent.click(screen.getByRole("button", { name: "New tab" }))
    mocks.location = { pathname: "/inbox", href: "/inbox" }
    fireEvent.click(screen.getByRole("button", { name: "New tab" }))
    await act(() => {
      resolvers[0]("/forge")
      resolvers[1]("/inbox")
      return Promise.resolve()
    })
    expect(mocks.home).toHaveBeenCalledTimes(2)
    expect(mocks.navigate).toHaveBeenCalledTimes(1)
    expect(mocks.navigate).toHaveBeenCalledWith({ href: "/inbox" })
  })
  it("discards a late default result after explicit navigation", async () => {
    let resolve!: (path: string) => void
    mocks.home.mockReturnValue(
      new Promise<string>((done) => {
        resolve = done
      })
    )
    render(
      <>
        <DesktopTitleBar />
        <a href="/settings">Settings link</a>
      </>
    )
    await act(() => Promise.resolve())
    fireEvent.click(screen.getByRole("button", { name: "New tab" }))
    fireEvent.click(screen.getByText("Settings link"), { metaKey: true })
    await act(() => {
      resolve("/forge")
      return Promise.resolve()
    })
    expect(mocks.navigate).toHaveBeenCalledTimes(1)
    expect(mocks.navigate).toHaveBeenCalledWith({ href: "/settings" })
  })
  it("discards a late default result after a session change", async () => {
    let resolve!: (path: string) => void
    mocks.home.mockReturnValue(
      new Promise<string>((done) => {
        resolve = done
      })
    )
    render(<DesktopTitleBar />)
    await act(() => Promise.resolve())
    fireEvent.click(screen.getByRole("button", { name: "New tab" }))
    retireProtectedSession()
    await act(() => {
      resolve("/forge")
      return Promise.resolve()
    })
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
  it("AT-03 preserves restored tabs and the authoritative explicit current URL", async () => {
    mocks.storage.set(
      "forge:desktop-tabs",
      JSON.stringify(
        createDesktopTabs("/teams/product/issues?issue=FOR-131#comment")
      )
    )
    render(<DesktopTitleBar />)
    await act(() => Promise.resolve())
    expect(mocks.navigate).not.toHaveBeenCalled()
    const saved = JSON.parse(mocks.storage.get("forge:desktop-tabs")!)
    expect(saved.tabs[0].history).toEqual([
      "/teams/product/issues?issue=FOR-131#comment",
      mocks.location.href,
    ])
    fireEvent.click(screen.getByRole("button", { name: "Go back" }))
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      href: "/teams/product/issues?issue=FOR-131#comment",
    })
    expect(mocks.home).not.toHaveBeenCalled()
  })
  it("AT-03 preserves explicit links opened in a new tab", async () => {
    render(
      <>
        <DesktopTitleBar />
        <a href="/teams/product/issues?issue=FOR-131#comment">Issue link</a>
      </>
    )
    await act(() => Promise.resolve())
    fireEvent.click(screen.getByText("Issue link"), { metaKey: true })
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      href: "/teams/product/issues?issue=FOR-131#comment",
    })
  })
})
