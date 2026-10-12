// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CodeReviewsSettings } from "./code-reviews-settings"
import {
  codeReviewStorageKey,
  readCodeReviewPreferences,
} from "@/lib/code-review-preferences"

afterEach(cleanup)
beforeEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})
describe("Code & reviews", () => {
  it("keeps GitHub-only controls gated and explains code access", () => {
    render(<CodeReviewsSettings userId="alice" />)
    for (const name of [
      "Review requests",
      "GitHub team review requests",
      "Checks & merge queue",
      "Require signed commits",
    ]) {
      expect(
        screen.getByRole("switch", { name }).getAttribute("aria-disabled")
      ).toBe("true")
    }
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add code access to GitHub integration",
      })
    )
    expect(screen.getByRole("dialog").textContent).toContain(
      "not available in Forge yet"
    )
  })
  it("persists the branch-copy preference when the page remounts", () => {
    const first = render(<CodeReviewsSettings userId="alice" />)
    fireEvent.click(
      screen.getByRole("switch", {
        name: "On git branch copy, move issue to started status",
      })
    )
    expect(readCodeReviewPreferences("alice").startOnBranchCopy).toBe(false)
    first.unmount()
    render(<CodeReviewsSettings userId="alice" />)
    expect(
      screen
        .getByRole("switch", {
          name: "On git branch copy, move issue to started status",
        })
        .getAttribute("aria-checked")
    ).toBe("false")
  })
  it("saves coding tool selections from the dialog", () => {
    render(<CodeReviewsSettings userId="alice" />)
    fireEvent.click(
      screen.getByRole("button", { name: "Configure coding tools" })
    )
    fireEvent.click(screen.getByRole("checkbox", { name: "Zed" }))
    expect(readCodeReviewPreferences("alice").codingTools).toContain("zed")
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(screen.queryByRole("dialog")).toBeNull()
  })
  it("does not pretend a preference saved when storage fails", async () => {
    window.localStorage.setItem(
      codeReviewStorageKey("alice"),
      '{"startOnToolOpen":true}'
    )
    render(<CodeReviewsSettings userId="alice" />)
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Unavailable")
    })
    fireEvent.click(
      screen.getByRole("switch", {
        name: "On open in coding tool, move issue to started status",
      })
    )
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", {
            name: "On open in coding tool, move issue to started status",
          })
          .getAttribute("aria-checked")
      ).toBe("true")
    )
  })
})
