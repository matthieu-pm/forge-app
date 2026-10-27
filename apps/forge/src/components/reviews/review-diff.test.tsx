import { useState } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ReviewDiff } from "./review-diff"
import { createSimulatedReviewDetail } from "@/lib/review-detail-demo"
import { emptyReviewEdit } from "@/lib/review-detail"
import { createSimulatedReviews } from "@/lib/reviews-demo"
import { selectOption } from "@/test-utils/select-option"

const review = createSimulatedReviews({ id: "me", name: "Me" })[0]
const detail = createSimulatedReviewDetail(review, "me", "Me")
const onCopy = vi.fn()
function Harness() {
  const [edit, setEdit] = useState(emptyReviewEdit)
  return (
    <ReviewDiff
      detail={detail}
      edit={edit}
      mutable
      onChange={(changes) => setEdit((current) => ({ ...current, ...changes }))}
      onCopy={onCopy}
    />
  )
}
beforeEach(() => {
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
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})
describe("Review diff", () => {
  it("expands hidden context and generated files, collapses cards and copies their paths", () => {
    render(<Harness />)
    expect(
      screen.getByText("Generated files are not shown by default")
    ).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Expand 3 lines above" })
    )
    expect(
      screen.getByText("// Fictional source for the Reviews preview")
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Show diff" }))
    expect(
      screen.queryByText("Generated files are not shown by default")
    ).toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: `Copy path: ${detail.files[0].path}` })
    )
    expect(onCopy).toHaveBeenCalledWith(detail.files[0].path, "File path")
    fireEvent.click(
      screen.getByRole("button", { name: `Collapse ${detail.files[0].path}` })
    )
    expect(
      screen.queryByText("// Fictional source for the Reviews preview")
    ).toBeNull()
  })
  it("marks files reviewed and adds, resolves and reopens line threads", () => {
    render(<Harness />)
    const checkbox = screen.getByRole("checkbox", {
      name: `Mark ${detail.files[0].path} reviewed`,
    })
    fireEvent.click(checkbox)
    expect(checkbox.getAttribute("aria-checked")).toBe("true")
    expect(screen.getByText("1/4 reviewed")).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", {
        name: `Comment on ${detail.files[0].path} new line 19`,
      })
    )
    fireEvent.change(
      screen.getByRole("textbox", { name: "Comment on line 19" }),
      { target: { value: "Please retain the attachment identifiers." } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }))
    expect(
      screen.getByText("Please retain the attachment identifiers.")
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Resolve thread" }))
    expect(screen.getByText("Line 19 · Resolved")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Reopen thread" }))
    expect(screen.getByText("Line 19 · Comment")).toBeTruthy()
  })
  it("filters the file navigator and narrows file diffs by commit", () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole("button", { name: "Files 4" }))
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a file" }), {
      target: { value: "no-such-file" },
    })
    expect(screen.getByText("No matching files")).toBeTruthy()
    selectOption(
      screen.getByRole("combobox", { name: "Select commit" }),
      `${detail.commits[1].sha} · ${detail.commits[1].title}`
    )
    expect(screen.getByRole("button", { name: "Files 1" })).toBeTruthy()
    expect(
      screen.queryByRole("article", {
        name: `Changes in ${detail.files[0].path}`,
      })
    ).toBeNull()
    expect(
      screen.getByRole("article", {
        name: `Changes in ${detail.files[1].path}`,
      })
    ).toBeTruthy()
  })
  it("supports side-by-side layout and line wrapping", () => {
    render(<Harness />)
    fireEvent.click(
      screen.getByRole("button", { name: "Diff display options" })
    )
    selectOption(
      screen.getByRole("combobox", { name: "Diff layout" }),
      "Side by side"
    )
    expect(
      screen.getByRole("combobox", { name: "Diff layout" }).textContent
    ).toBe("Side by side")
    fireEvent.click(screen.getByRole("switch", { name: "Wrap lines" }))
    expect(
      screen
        .getByRole("switch", { name: "Wrap lines" })
        .getAttribute("aria-checked")
    ).toBe("true")
    const card = screen.getByRole("article", {
      name: `Changes in ${detail.files[0].path}`,
    })
    expect(
      within(card).getByRole("button", {
        name: `Comment on ${detail.files[0].path} old line 19`,
      })
    ).toBeTruthy()
    expect(
      within(card).getByRole("button", {
        name: `Comment on ${detail.files[0].path} new line 19`,
      })
    ).toBeTruthy()
  })
})
