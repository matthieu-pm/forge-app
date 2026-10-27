import { HugeiconsIcon } from "@hugeicons/react"
import { Link } from "@tanstack/react-router"
import { Fragment, useEffect, useRef, useState } from "react"
import {
  ArrowLeft01Icon,
  ArrowUpRight01Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons"
import { ReviewDisplayOptions, ReviewFiltersMenu } from "./review-controls"
import type { Review, ReviewDisplay } from "@/lib/reviews-view"
import type { InboxScope } from "@/lib/inbox-state"
import {
  defaultReviewDisplay,
  emptyReviewFilters,
  hasReviewFilters,
  readReviewDisplay,
  reviewDisplayKey,
  reviewGroup,
  visibleReviews,
} from "@/lib/reviews-view"
import { InboxSidebar } from "@/components/inbox/inbox-sidebar"
import { ContentHeader } from "@/components/ui/content-header"
import { PageTabs, pageTabClass } from "@/components/ui/page-tabs"
import { ActionIconButton } from "@/components/ui/action-icon-button"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/** An original line illustration matching the quiet Reviews empty state. */
function ReviewsEmptyMark() {
  return (
    <svg
      viewBox="0 0 180 160"
      className="h-36 w-40 text-muted-foreground"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <g opacity=".4" strokeDasharray="4 4">
        <ellipse cx="90" cy="112" rx="70" ry="43" />
        <ellipse cx="90" cy="110" rx="64" ry="39" />
        <ellipse cx="90" cy="108" rx="58" ry="35" />
      </g>
      <path
        d="M69 38v17L53 97c-4 12 13 23 37 23s41-11 37-23l-16-42V38"
        className="text-foreground/70"
      />
      <ellipse cx="90" cy="37" rx="21" ry="10" className="text-foreground/70" />
      <ellipse cx="90" cy="37" rx="16" ry="6" />
      <path
        d="M69 53c0 6 9 11 21 11s21-5 21-11M55 93c5-9 19-14 35-14s30 5 35 14"
        opacity=".35"
      />
    </svg>
  )
}
const noReviews: ReadonlyArray<Review> = []
export function Reviews({
  scope,
  view,
  entries = noReviews,
  simulated = false,
}: {
  scope: InboxScope
  view: "for-you" | "created"
  entries?: ReadonlyArray<Review>
  simulated?: boolean
}) {
  const [display, setDisplay] = useState<ReviewDisplay>(defaultReviewDisplay)
  const [filters, setFilters] = useState(emptyReviewFilters)
  const [filterOpen, setFilterOpen] = useState(false)
  const [displayOpen, setDisplayOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [saveError, setSaveError] = useState(false)
  const root = useRef<HTMLElement>(null)
  const key = reviewDisplayKey(scope)
  useEffect(() => {
    setDisplay(readReviewDisplay(key))
    root.current?.focus({ preventScroll: true })
  }, [key])
  const visible = visibleReviews(entries, scope.userId, view, filters, display)
  const selected = visible.find((review) => review.id === selectedId)
  const groups = new Map<string, Array<Review>>()
  for (const review of visible) {
    const group = reviewGroup(review, display.groupBy, scope.userId)
    groups.set(group, [...(groups.get(group) ?? []), review])
  }
  function updateDisplay(next: ReviewDisplay) {
    setDisplay(next)
    try {
      localStorage.setItem(key, JSON.stringify(next))
      setSaveError(false)
    } catch {
      setSaveError(true)
    }
  }
  return (
    <main
      ref={root}
      aria-label="Reviews"
      tabIndex={-1}
      className="relative flex min-h-0 flex-1 overflow-hidden outline-none"
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          (event.target as HTMLElement).closest(
            "input, textarea, select, [contenteditable=true], [role=dialog], [role=combobox], [role=menu]"
          )
        )
          return
        if (event.key.toLowerCase() === "f") {
          event.preventDefault()
          setFilterOpen(true)
        }
        if (event.shiftKey && event.key.toLowerCase() === "v") {
          event.preventDefault()
          setDisplayOpen(true)
        }
        if (event.key === "Escape") setSelectedId(null)
      }}
    >
      <InboxSidebar
        scope={scope}
        selected={Boolean(selected)}
        label="Reviews list"
        storageNamespace="reviews"
        resizeLabel="Resize reviews sidebar"
      >
        <ContentHeader>
          <h1 className="text-[13px] font-medium">Reviews</h1>
          {simulated && (
            <Badge
              variant="secondary"
              className="text-[10px] font-normal"
              title="Fictional pull requests for exploring Reviews"
            >
              Simulated data
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <ReviewFiltersMenu
              entries={entries}
              value={filters}
              onChange={setFilters}
              open={filterOpen}
              onOpenChange={setFilterOpen}
            />
            <ReviewDisplayOptions
              value={display}
              onChange={updateDisplay}
              open={displayOpen}
              onOpenChange={setDisplayOpen}
            />
          </div>
        </ContentHeader>
        <PageTabs aria-label="Review views" className="shrink-0 px-3 py-2">
          <Link
            to="/reviews"
            className={pageTabClass}
            aria-current={view === "for-you" ? "page" : undefined}
          >
            For you
          </Link>
          <Link
            to="/reviews/created"
            className={pageTabClass}
            aria-current={view === "created" ? "page" : undefined}
          >
            Created
          </Link>
        </PageTabs>
        {hasReviewFilters(filters) && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border/40 px-3 pb-2">
            {Object.entries(filters)
              .filter(([field, value]) =>
                field === "content" ? value.trim() : value !== "all"
              )
              .map(([field, value]) => (
                <Button
                  key={field}
                  variant="outline"
                  size="xs"
                  className="max-w-full text-[11px] font-normal"
                  onClick={() =>
                    setFilters({
                      ...filters,
                      [field]: field === "content" ? "" : "all",
                    })
                  }
                  aria-label={`Remove ${field} filter`}
                >
                  <span className="truncate">
                    {field[0].toUpperCase() + field.slice(1)}:{" "}
                    {field === "author"
                      ? (entries.find((r) => r.author.id === value)?.author
                          .name ?? value)
                      : value}
                  </span>
                  <Cancel01IconComponent />
                </Button>
              ))}
          </div>
        )}
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto p-2",
            !visible.length && "flex flex-col justify-center"
          )}
          aria-label="Pull requests"
        >
          {[...groups].map(([group, reviews]) => (
            <Fragment key={group}>
              {group && (
                <h2 className="px-2.5 pt-3 pb-2 text-[11px] font-medium text-muted-foreground">
                  {group}
                </h2>
              )}
              {reviews.map((review) => (
                <button
                  key={review.id}
                  aria-pressed={selected?.id === review.id}
                  onClick={() => setSelectedId(review.id)}
                  className={cn(
                    "mb-0.5 flex w-full flex-col gap-1 rounded-lg px-2.5 py-3 text-left hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    selected?.id === review.id && "bg-muted/70"
                  )}
                >
                  <span className="line-clamp-2 text-[13px]">
                    {review.title}
                  </span>
                  <span className="flex w-full flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                    {display.properties.includes("repository") && (
                      <span>{review.repository}</span>
                    )}
                    {display.properties.includes("id") && (
                      <span>#{review.number}</span>
                    )}
                    {display.properties.includes("author") && (
                      <span>{review.author.name}</span>
                    )}
                    {display.properties.includes("timestamp") && (
                      <time dateTime={review.updatedAt}>
                        {new Date(review.updatedAt).toLocaleDateString(
                          undefined,
                          { month: "short", day: "numeric" }
                        )}
                      </time>
                    )}
                    {display.properties.includes("labels") && (
                      <span>{review.labels.join(", ")}</span>
                    )}
                    {display.properties.includes("status") && (
                      <span>
                        {review.status} ·{" "}
                        {review.reviewState.replaceAll("-", " ")}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </Fragment>
          ))}
          {!visible.length && !hasReviewFilters(filters) && (
            <div className="flex flex-col items-center justify-center gap-6 px-6 py-12 md:hidden">
              <ReviewsEmptyMark />
              <p className="text-[13px] text-muted-foreground">
                Nothing to review
              </p>
            </div>
          )}
          {!visible.length && hasReviewFilters(filters) && (
            <div className="px-4 py-12 text-center">
              <p className="text-xs text-muted-foreground">
                No matching reviews
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-3 text-xs"
                onClick={() => setFilters(emptyReviewFilters())}
              >
                Clear filters
              </Button>
            </div>
          )}
        </div>
        {saveError && (
          <p role="alert" className="px-4 py-3 text-xs text-destructive">
            Display changes apply for now but could not be saved.
          </p>
        )}
      </InboxSidebar>
      <section
        aria-label="Review details"
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col",
          selected ? "flex" : "hidden md:flex"
        )}
      >
        {selected ? (
          <>
            <ContentHeader>
              <ActionIconButton
                className="md:hidden"
                label="Back to reviews"
                icon={ArrowLeft01Icon}
                onClick={() => {
                  setSelectedId(null)
                  root.current?.focus()
                }}
              />
              <span className="truncate text-xs text-muted-foreground">
                {selected.repository} #{selected.number}
              </span>
            </ContentHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
              <div className="mx-auto max-w-3xl">
                <p className="mb-3 text-xs text-muted-foreground capitalize">
                  {selected.status} ·{" "}
                  {selected.reviewState.replaceAll("-", " ")}
                </p>
                <h2 className="text-xl font-semibold">{selected.title}</h2>
                <p className="mt-2 text-xs text-muted-foreground">
                  Opened by {selected.author.name}
                </p>
                <p className="mt-8 text-sm leading-7 whitespace-pre-wrap">
                  {selected.description || "No description provided."}
                </p>
                {/^https:\/\/github\.com\//.test(selected.url) && (
                  <Button
                    render={
                      <a href={selected.url} target="_blank" rel="noreferrer" />
                    }
                    variant="outline"
                    className="mt-8 text-xs"
                  >
                    Open in GitHub
                    <ArrowUpRightIconComponent />
                  </Button>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
            <ReviewsEmptyMark />
            <p className="text-[13px] text-muted-foreground">
              {entries.length
                ? visible.length
                  ? "Select a review"
                  : hasReviewFilters(filters)
                    ? "No matching reviews"
                    : "Nothing to review"
                : "Nothing to review"}
            </p>
          </div>
        )}
      </section>
    </main>
  )
}
function Cancel01IconComponent() {
  return <HugeiconsIcon icon={Cancel01Icon} className="size-3" />
}
function ArrowUpRightIconComponent() {
  return <HugeiconsIcon icon={ArrowUpRight01Icon} className="size-3.5" />
}
