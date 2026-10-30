import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Reviews } from "./reviews"
import type { ReactNode } from "react"
import type { Review } from "@/lib/reviews-view"
import {
  readTestView,
  renderPreferences as render,
  setupPreferenceFixture,
} from "@/test/preference-fixture"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))
const scope = { workspaceId: "workspace", userId: "me" }
const entries: Array<Review> = [
  {
    id: "pr",
    number: 12,
    title: "Fix navigation",
    description: "Preserve sidebar state",
    repository: "forge/app",
    author: { id: "other", name: "Teammate" },
    reviewerIds: ["me"],
    participatedUserIds: [],
    teamReview: false,
    status: "open",
    reviewState: "requested",
    labels: [],
    openedAt: "2026-10-25T12:00:00Z",
    updatedAt: "2026-10-27T10:00:00Z",
    closedAt: null,
    url: "https://github.com/forge/app/pull/12",
  },
]
beforeEach(async () => {
  await setupPreferenceFixture("me")
  localStorage.clear()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
describe("Reviews", () => {
  it("renders the empty state with real view links and the shared resize control", () => {
    render(<Reviews scope={scope} view="created" />)
    expect(screen.getByRole("heading", { name: "Reviews" })).toBeTruthy()
    expect(
      screen.getByRole("link", { name: "For you" }).getAttribute("href")
    ).toBe("/reviews")
    expect(
      screen.getByRole("link", { name: "Created" }).getAttribute("aria-current")
    ).toBe("page")
    expect(
      screen.getByRole("separator", { name: "Resize reviews sidebar" })
    ).toBeTruthy()
    expect(screen.getAllByText("Nothing to review").length).toBeGreaterThan(0)
  })
  it("opens a PR and clears selection when filters exclude it", async () => {
    render(<Reviews scope={scope} view="for-you" entries={entries} />)
    fireEvent.click(screen.getByRole("button", { name: /Fix navigation/ }))
    expect(screen.getByRole("heading", { name: "Fix navigation" })).toBeTruthy()
    expect(
      screen.getByRole("link", { name: "Open in GitHub" }).getAttribute("href")
    ).toBe(entries[0].url)
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }))
    fireEvent.change(await screen.findByRole("searchbox"), {
      target: { value: "unmatched" },
    })
    expect(screen.queryByRole("heading", { name: "Fix navigation" })).toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: "Remove content filter" })
    )
    expect(screen.getByRole("button", { name: /Fix navigation/ })).toBeTruthy()
  })
  it("persists display options and restores them after remount", async () => {
    const page = render(<Reviews scope={scope} view="for-you" />)
    fireEvent.click(screen.getByRole("button", { name: "Display options" }))
    const toggle = await screen.findByRole("switch", { name: "Show drafts" })
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(readTestView("reviews").display.showDrafts).toBe(false)
    )
    page.unmount()
    render(<Reviews scope={scope} view="created" />)
    fireEvent.click(screen.getByRole("button", { name: "Display options" }))
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Show drafts" })
          .getAttribute("aria-checked")
      ).toBe("false")
    )
  })
})
