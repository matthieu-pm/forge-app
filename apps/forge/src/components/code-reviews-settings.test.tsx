// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CodeReviewsSettings } from "./code-reviews-settings"
import {
  failPreferenceSaves,
  readTestPreferences,
  renderPreferences,
  setupPreferenceFixture,
} from "@/test/preference-fixture"

afterEach(cleanup)
beforeEach(async () => {
  await setupPreferenceFixture()
  window.localStorage.clear()
  vi.restoreAllMocks()
})
describe("Code & reviews", () => {
  it("keeps GitHub-only controls gated and explains code access", () => {
    renderPreferences(<CodeReviewsSettings userId="alice" />)
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
    const first = renderPreferences(<CodeReviewsSettings userId="alice" />)
    fireEvent.click(
      screen.getByRole("switch", {
        name: "On git branch copy, move issue to started status",
      })
    )
    expect(readTestPreferences("alice").reviews.startOnBranchCopy).toBe(false)
    first.unmount()
    renderPreferences(<CodeReviewsSettings userId="alice" />)
    expect(
      screen
        .getByRole("switch", {
          name: "On git branch copy, move issue to started status",
        })
        .getAttribute("aria-checked")
    ).toBe("false")
  })
  it("saves coding tool selections from the dialog", () => {
    renderPreferences(<CodeReviewsSettings userId="alice" />)
    fireEvent.click(
      screen.getByRole("button", { name: "Configure coding tools" })
    )
    fireEvent.click(screen.getByRole("checkbox", { name: "Zed" }))
    expect(readTestPreferences("alice").reviews.codingTools).toContain("zed")
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(screen.queryByRole("dialog")).toBeNull()
  })
  it("shows failed account saves and keeps the desired value visibly unsaved", async () => {
    renderPreferences(<CodeReviewsSettings userId="alice" />)
    failPreferenceSaves("alice")
    fireEvent.click(
      screen.getByRole("switch", {
        name: "On open in coding tool, move issue to started status",
      })
    )
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("not saved")
    )
    expect(
      screen
        .getByRole("switch", {
          name: "On open in coding tool, move issue to started status",
        })
        .getAttribute("aria-checked")
    ).toBe("false")
  })
})
