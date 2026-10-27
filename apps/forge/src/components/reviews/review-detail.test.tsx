import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Reviews } from "./reviews"
import type { ReactNode } from "react"
import { createSimulatedReviews } from "@/lib/reviews-demo"
import { reviewEditsKey } from "@/lib/review-detail"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))
const scope = { workspaceId: "workspace", userId: "me" }
const entries = createSimulatedReviews({ id: "me", name: "Alex" })
function start() {
  return render(
    <Reviews
      entries={entries}
      simulated
      scope={scope}
      view="for-you"
      currentUserName="Alex"
    />
  )
}
function openFirst() {
  fireEvent.click(
    screen.getByRole("button", {
      name: /Keep issue drafts when switching teams/,
    })
  )
}
beforeEach(() => {
  localStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe("Simulated review detail", () => {
  it("persists title edits, comments and favorites, isolated to the workspace", () => {
    const page = start()
    openFirst()
    fireEvent.change(
      screen.getByRole("textbox", { name: "Pull request title" }),
      { target: { value: "Preserve the issue draft" } }
    )
    fireEvent.blur(screen.getByRole("textbox", { name: "Pull request title" }))
    fireEvent.click(screen.getByRole("button", { name: "Add to favorites" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Leave a comment" }), {
      target: { value: "The draft restoration looks good." },
    })
    fireEvent.click(screen.getByRole("button", { name: "Submit comment" }))
    expect(screen.getByText("The draft restoration looks good.")).toBeTruthy()
    page.unmount()
    start()
    fireEvent.click(
      screen.getByRole("button", { name: /Preserve the issue draft/ })
    )
    expect(
      screen
        .getByRole("button", { name: "Remove from favorites" })
        .getAttribute("aria-pressed")
    ).toBe("true")
    expect(screen.getByText("The draft restoration looks good.")).toBeTruthy()
    expect(
      localStorage.getItem(reviewEditsKey({ ...scope, workspaceId: "another" }))
    ).toBeNull()
  })
  it("submits a local approval, confirms a simulated merge, and can reset the preview", async () => {
    start()
    openFirst()
    fireEvent.click(screen.getByRole("button", { name: "Review" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Submit simulated review" })
    )
    expect(screen.getByText("Alex approved these changes")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Squash & merge" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Simulate squash & merge" })
    )
    expect(
      screen.getByText("Alex squash-merged this simulated pull request")
    ).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Pull request actions" })
    )
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Reset simulated review" })
    )
    expect(
      screen.queryByText("Alex squash-merged this simulated pull request")
    ).toBeNull()
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy()
  })
  it("opens a file from the overview and persists reviewed state across PR navigation", async () => {
    start()
    openFirst()
    fireEvent.click(screen.getByRole("button", { name: /^Implementation/ }))
    fireEvent.click(screen.getByRole("button", { name: /issue-composer.tsx/ }))
    expect(
      screen.getByRole("button", { name: "Diff" }).getAttribute("aria-current")
    ).toBe("page")
    const reviewed = screen.getByRole("checkbox", {
      name: "Mark src/components/issues/issue-composer.tsx reviewed",
    })
    fireEvent.click(reviewed)
    fireEvent.click(
      screen.getByRole("button", {
        name: /Add keyboard navigation to the cycle picker/,
      })
    )
    openFirst()
    fireEvent.click(screen.getByRole("button", { name: "Diff" }))
    await waitFor(() =>
      expect(
        screen
          .getByRole("checkbox", {
            name: "Mark src/components/issues/issue-composer.tsx reviewed",
          })
          .getAttribute("aria-checked")
      ).toBe("true")
    )
  })
})
