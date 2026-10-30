import { describe, expect, it } from "vitest"
import {
  defaultReviewDisplay,
  emptyReviewFilters,
  readReviewDisplay,
  reviewDisplayKey,
  reviewGroup,
  visibleReviews,
} from "./reviews-view"
import type { Review } from "./reviews-view"
import { productStorage } from "@/lib/product-storage"

const now = Date.parse("2026-10-27T12:00:00Z")
const review = (overrides: Partial<Review> = {}): Review => ({
  id: "pr",
  number: 12,
  title: "Fix navigation",
  description: "Preserve sidebar state",
  repository: "forge/app",
  author: { id: "teammate", name: "Teammate" },
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
  ...overrides,
})
const select = (
  entries: Array<Review>,
  view: "for-you" | "created" = "for-you",
  display = defaultReviewDisplay,
  filters = emptyReviewFilters()
) => visibleReviews(entries, "me", view, filters, display, now)

describe("Reviews view", () => {
  it("separates authored PRs from personal requests, participation, team requests and unrelated work", () => {
    const entries = [
      review(),
      review({ id: "mine", author: { id: "me", name: "Me" }, reviewerIds: [] }),
      review({
        id: "participated",
        reviewerIds: [],
        participatedUserIds: ["me"],
      }),
      review({ id: "team", reviewerIds: [], teamReview: true }),
      review({ id: "unrelated", reviewerIds: [] }),
    ]
    expect(select(entries).map((r) => r.id)).toEqual([
      "pr",
      "mine",
      "participated",
      "team",
    ])
    expect(select(entries, "created").map((r) => r.id)).toEqual(["mine"])
    expect(
      select(entries, "for-you", {
        ...defaultReviewDisplay,
        showTeamReviews: false,
      }).map((r) => r.id)
    ).toEqual(["pr", "mine", "participated"])
  })
  it("combines filters and excludes hidden drafts and stale closed PRs", () => {
    const entries = [
      review(),
      review({ id: "draft", status: "draft" }),
      review({ id: "old", status: "merged", closedAt: "2026-10-20T12:00:00Z" }),
      review({
        id: "recent",
        status: "merged",
        closedAt: "2026-10-27T11:00:00Z",
      }),
    ]
    expect(
      select(entries, "for-you", {
        ...defaultReviewDisplay,
        showDrafts: false,
      }).map((r) => r.id)
    ).toEqual(["pr", "recent"])
    expect(
      select(entries, "for-you", defaultReviewDisplay, {
        ...emptyReviewFilters(),
        status: "open",
        content: "SIDEBAR",
        repository: "forge/app",
      }).map((r) => r.id)
    ).toEqual(["pr"])
    expect(
      select(entries, "for-you", {
        ...defaultReviewDisplay,
        closedReviews: "none",
      }).map((r) => r.id)
    ).toEqual(["draft", "pr"])
  })
  it("prioritizes review requests and groups focus by the current user", () => {
    const own = review({
      id: "own",
      reviewerIds: [],
      author: { id: "me", name: "Me" },
      reviewState: "changes-requested",
      updatedAt: "2026-10-27T11:00:00Z",
    })
    expect(select([own, review()]).map((r) => r.id)).toEqual(["pr", "own"])
    expect(
      select([own, review()], "for-you", {
        ...defaultReviewDisplay,
        orderBy: "updated",
      }).map((r) => r.id)
    ).toEqual(["own", "pr"])
    expect(reviewGroup(own, "focus", "me")).toBe("Needs your attention")
  })
  it("isolates and validates saved display preferences", () => {
    const key = reviewDisplayKey({ userId: "me", workspaceId: "one" })
    productStorage.setItem(key, JSON.stringify({ showDrafts: false }))
    expect(readReviewDisplay(key).showDrafts).toBe(false)
    expect(
      readReviewDisplay(reviewDisplayKey({ userId: "me", workspaceId: "two" }))
        .showDrafts
    ).toBe(true)
    productStorage.setItem(key, '{"groupBy":"invalid"}')
    expect(readReviewDisplay(key)).toEqual(defaultReviewDisplay)
    productStorage.setItem(key, "not json")
    expect(readReviewDisplay(key)).toEqual(defaultReviewDisplay)
  })
})
