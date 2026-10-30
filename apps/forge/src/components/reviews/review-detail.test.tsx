import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Reviews } from "./reviews"
import type { ReactNode } from "react"
import { productStorage } from "@/lib/product-storage"
import { createSimulatedReviews } from "@/lib/reviews-demo"
import { readReviewEdits, reviewEditsKey } from "@/lib/review-detail"

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
  productStorage.clear()
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
  it("saves description reactions and attachments with the shared issue controls", async () => {
    const page = start()
    openFirst()
    fireEvent.click(screen.getByRole("button", { name: "Add reaction" }))
    fireEvent.change(screen.getByRole("textbox", { name: "Search emoji" }), {
      target: { value: "party popper" },
    })
    fireEvent.click(await screen.findByRole("button", { name: "party popper" }))
    expect(
      screen.getByRole("button", { name: /🎉.*1/ }).getAttribute("aria-pressed")
    ).toBe("true")
    fireEvent.change(screen.getByLabelText("Attach description files"), {
      target: {
        files: [
          new File(["Description attachment"], "design-notes.txt", {
            type: "text/plain",
          }),
        ],
      },
    })
    expect(await screen.findByText("design-notes.txt")).toBeTruthy()
    const saved = readReviewEdits(reviewEditsKey(scope))["reviews-demo:248"]
    expect(saved.reactions).toEqual([{ emoji: "🎉", users: ["me"] }])
    expect(saved.attachments[0]).toMatchObject({
      name: "design-notes.txt",
      data: expect.stringMatching(/^data:text\/plain;base64,/),
    })
    fireEvent.click(screen.getByRole("button", { name: "Description" }))
    expect(screen.queryByRole("button", { name: "Add reaction" })).toBeNull()
    expect(
      screen.queryByRole("button", { name: "Attach images, files, or videos" })
    ).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Expand description" }))
    expect(screen.getByText("design-notes.txt")).toBeTruthy()
    page.unmount()
    start()
    openFirst()
    expect(screen.getByText("design-notes.txt")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /🎉.*1/ }))
    expect(
      readReviewEdits(reviewEditsKey(scope))["reviews-demo:248"].reactions
    ).toEqual([])
  })
  it("collapses a rich description into a preview without changing its saved content", () => {
    productStorage.setItem(
      reviewEditsKey(scope),
      JSON.stringify({
        "reviews-demo:248": {
          description: "Keep this formatting",
          descriptionDoc: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "Keep this formatting",
                    marks: [{ type: "bold" }],
                  },
                ],
              },
            ],
          },
        },
      })
    )
    start()
    openFirst()
    const toggle = screen.getByRole("button", {
      name: "Description",
    })
    const editor = screen.getByRole("textbox", {
      name: "Pull request description",
    })
    expect(editor.querySelector("strong")?.textContent).toBe(
      "Keep this formatting"
    )
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(
      screen.queryByRole("textbox", { name: "Pull request description" })
    ).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Expand description" }))
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(
      screen.getByRole("textbox", { name: "Pull request description" })
    ).toBe(editor)
    expect(editor.querySelector("strong")?.textContent).toBe(
      "Keep this formatting"
    )
    expect(
      readReviewEdits(reviewEditsKey(scope))["reviews-demo:248"].activity
    ).toEqual([])
  })
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
      productStorage.getItem(
        reviewEditsKey({ ...scope, workspaceId: "another" })
      )
    ).toBeNull()
  })
  it("submits and restores attachments through the shared issue comment composer", async () => {
    const page = start()
    openFirst()
    const activity = screen.getByRole("region", { name: "Activity" })
    const file = activity.querySelector('input[type="file"]')!
    fireEvent.change(file, {
      target: {
        files: [
          new File(["Review notes"], "review-notes.txt", {
            type: "text/plain",
          }),
        ],
      },
    })
    await within(activity).findByText("review-notes.txt")
    fireEvent.click(screen.getByRole("button", { name: "Submit comment" }))
    const saved = JSON.parse(productStorage.getItem(reviewEditsKey(scope))!)[
      "reviews-demo:248"
    ]
    expect(saved.comments[0].attachments[0]).toMatchObject({
      name: "review-notes.txt",
      data: expect.stringMatching(/^data:text\/plain;base64,/),
    })
    page.unmount()
    start()
    openFirst()
    expect(await screen.findByText("review-notes.txt")).toBeTruthy()
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
    expect(screen.getByText("Merged by Alex", { exact: false })).toBeTruthy()
    expect(
      readReviewEdits(reviewEditsKey(scope))["reviews-demo:248"].activity.at(-1)
    ).toMatchObject({ status: "merged", actor: "Alex" })
    fireEvent.click(
      screen.getByRole("button", { name: "Pull request actions" })
    )
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Reset simulated review" })
    )
    expect(screen.queryByText("Merged by Alex", { exact: false })).toBeNull()
    expect(screen.getByRole("button", { name: "Review" })).toBeTruthy()
  })
  it("restores a single merge event from a previously saved preview", () => {
    const createdAt = new Date().toISOString()
    productStorage.setItem(
      reviewEditsKey(scope),
      JSON.stringify({
        "reviews-demo:248": {
          status: "merged",
          closedAt: createdAt,
          activity: [
            {
              id: "previous-merge",
              body: "Alex squash-merged this simulated pull request",
              createdAt,
            },
          ],
        },
      })
    )
    start()
    openFirst()
    const activity = screen.getByRole("region", { name: "Activity" })
    expect(within(activity).getAllByText(/Merged by Alex/)).toHaveLength(1)
    expect(activity.querySelectorAll("time")).toHaveLength(2)
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
