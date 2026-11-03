import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  FeatureAvailabilityProvider,
  FeatureUnavailable,
  useFeatureNavigation,
} from "./feature-availability"

const mocks = vi.hoisted(() => ({
  identity: { userId: "u1", workspaceId: "w1", sessionId: "s1" },
  load: vi.fn(),
}))
vi.mock("./account-preference-provider", () => ({
  useProtectedIdentity: () => mocks.identity,
}))
vi.mock("@/lib/feature-state", () => ({ loadFeatureAvailability: mocks.load }))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  mocks.identity = { userId: "u1", workspaceId: "w1", sessionId: "s1" }
})

function Navigation() {
  const visible = useFeatureNavigation()
  return (
    <nav>
      {[
        "/workspace/signals",
        "/reviews",
        "/settings/billing",
        "/teams/eng/issues",
      ]
        .filter(visible)
        .map((path) => (
          <a key={path} href={path}>
            {path}
          </a>
        ))}
    </nav>
  )
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("FOR-103 feature presentation", () => {
  it.each([
    "signals",
    "reviews",
    "insights",
    "billing",
    "applications",
    "integrations",
    "sla",
    "teamAgents",
  ] as const)("AT-01: %s is honestly unavailable with no action", (feature) => {
    render(<FeatureUnavailable feature={feature} />)
    expect(screen.getByRole("status").textContent).toMatch(
      /unavailable.*No changes have been saved or requested/
    )
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(screen.queryByLabelText("Fictional sample")).toBeNull()
  })
  it.each(["signals", "reviews"] as const)(
    "labels %s preview data fictional and offers no write or agent action",
    (feature) => {
      render(<FeatureUnavailable feature={feature} mode="preview" />)
      expect(screen.getByRole("status").textContent).toContain(
        "Fictional preview · Read-only sample data"
      )
      expect(screen.getByLabelText("Fictional sample")).toBeTruthy()
      expect(screen.queryByRole("button")).toBeNull()
      expect(screen.queryByRole("link")).toBeNull()
    }
  )
  it("hides gated navigation until the matching server snapshot arrives", async () => {
    const pending = deferred<unknown>()
    mocks.load.mockReturnValue(pending.promise)
    render(
      <FeatureAvailabilityProvider>
        <Navigation />
      </FeatureAvailabilityProvider>
    )
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(
      ["/teams/eng/issues"]
    )
    await act(() =>
      pending.resolve({
        ...mocks.identity,
        features: { signals: "preview", billing: "enabled" },
      })
    )
    expect(
      screen.getByRole("link", { name: "/workspace/signals" })
    ).toBeTruthy()
    expect(screen.getByRole("link", { name: "/settings/billing" })).toBeTruthy()
    expect(screen.queryByRole("link", { name: "/reviews" })).toBeNull()
    mocks.load.mockRejectedValue(new Error("offline"))
    act(() => window.dispatchEvent(new Event("focus")))
    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: "/workspace/signals" })
      ).toBeNull()
    )
  })
  it("ignores a late previous-workspace response and immediately removes its navigation", async () => {
    const old = deferred<unknown>(),
      next = deferred<unknown>()
    mocks.load
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(next.promise)
    const view = render(
      <FeatureAvailabilityProvider>
        <Navigation />
      </FeatureAvailabilityProvider>
    )
    mocks.identity = { userId: "u2", workspaceId: "w2", sessionId: "s2" }
    view.rerender(
      <FeatureAvailabilityProvider>
        <Navigation />
      </FeatureAvailabilityProvider>
    )
    await act(() =>
      old.resolve({
        userId: "u1",
        workspaceId: "w1",
        sessionId: "s1",
        features: { signals: "preview" },
      })
    )
    expect(
      screen.queryByRole("link", { name: "/workspace/signals" })
    ).toBeNull()
    await act(() =>
      next.resolve({ ...mocks.identity, features: { reviews: "preview" } })
    )
    expect(screen.getByRole("link", { name: "/reviews" })).toBeTruthy()
    expect(
      screen.queryByRole("link", { name: "/workspace/signals" })
    ).toBeNull()
  })
})
