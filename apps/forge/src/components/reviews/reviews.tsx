import { HugeiconsIcon } from "@hugeicons/react"
import { Link } from "@tanstack/react-router"
import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons"
import { ReviewDisplayOptions, ReviewFiltersMenu } from "./review-controls"
import { ReviewDetail, ReviewStatusIcon } from "./review-detail"
import type {
  ReviewDetail as Detail,
  ReviewEdit,
  ReviewSearch,
} from "@/lib/review-detail"
import type { Review, ReviewDisplay } from "@/lib/reviews-view"
import type { InboxScope } from "@/lib/inbox-state"
import { productStorage } from "@/lib/product-storage"
import { useWorkspaceView } from "@/components/account-preference-provider"
import { IllustratedEmptyState } from "@/components/illustrations/illustrated-empty-state"
import {
  applyReviewEdit,
  emptyReviewEdit,
  readReviewEdits,
  reviewEditsKey,
} from "@/lib/review-detail"
import { createSimulatedReviewDetail } from "@/lib/review-detail-demo"
import {
  emptyReviewFilters,
  hasReviewFilters,
  reviewGroup,
  visibleReviews,
} from "@/lib/reviews-view"
import { InboxSidebar } from "@/components/inbox/inbox-sidebar"
import { ContentHeader } from "@/components/ui/content-header"
import { PageTabs, pageTabClass } from "@/components/ui/page-tabs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const noReviews: ReadonlyArray<Review> = []
const emptyDetail: Detail = {
  branch: "",
  baseBranch: "main",
  checks: "pending",
  files: [],
  people: [],
  issues: [],
  commits: [],
}
export function Reviews({
  scope,
  view,
  entries = noReviews,
  simulated = false,
  selection,
  onNavigate,
  currentUserName = "You",
  onOpenAgent,
}: {
  scope: InboxScope
  view: "for-you" | "created"
  entries?: ReadonlyArray<Review>
  simulated?: boolean
  selection?: ReviewSearch
  onNavigate?: (search: ReviewSearch) => void
  currentUserName?: string
  onOpenAgent?: (review: Review) => void
}) {
  const sync = useWorkspaceView("reviews", "main", scope)
  const { display, filters } = sync.value
  const setFilters = (next: typeof filters) => {
    if (!sync.save({ ...sync.value, filters: next })) setSaveError(true)
  }
  const [filterOpen, setFilterOpen] = useState(false)
  const [displayOpen, setDisplayOpen] = useState(false)
  const [localSelection, setLocalSelection] = useState<ReviewSearch>(
    selection ?? {}
  )
  const [edits, setEdits] = useState<Record<string, ReviewEdit>>({})
  const [expanded, setExpanded] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Array<string>>([])
  const [announcement, setAnnouncement] = useState("")
  const [now, setNow] = useState(Date.now)
  const currentSelection = localSelection
  useEffect(() => {
    if (selection) setLocalSelection(selection)
  }, [selection])
  const selectedId = currentSelection.review
  function navigate(next: ReviewSearch) {
    setLocalSelection(next)
    onNavigate?.(next)
  }
  function closeReview() {
    navigate({})
    setExpanded(false)
    root.current?.focus()
  }
  function updateReview(id: string, changes: Partial<ReviewEdit>) {
    if (!simulated) return
    const next = {
      ...edits,
      [id]: { ...(edits[id] ?? emptyReviewEdit()), ...changes },
    }
    setEdits(next)
    try {
      productStorage.setItem(reviewEditsKey(scope), JSON.stringify(next))
      setSaveError(false)
    } catch {
      setSaveError(true)
    }
  }
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      setAnnouncement(`${label} copied`)
    } catch {
      setAnnouncement(`Could not copy ${label.toLowerCase()}`)
    }
  }
  const [saveError, setSaveError] = useState(false)
  const root = useRef<HTMLElement>(null)
  const key = JSON.stringify(scope)
  useEffect(() => {
    setEdits(simulated ? readReviewEdits(reviewEditsKey(scope)) : {})
    root.current?.focus({ preventScroll: true })
  }, [key, simulated, scope.workspaceId, scope.userId])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const effectiveEntries = entries.map((review) =>
    applyReviewEdit(review, edits[review.id])
  )
  const visible = visibleReviews(
    effectiveEntries,
    scope.userId,
    view,
    filters,
    display,
    now
  )
  const selected = visible.find((review) => review.id === selectedId)
  const originalSelected = entries.find((review) => review.id === selectedId)
  const selectedDetail = useMemo(
    () =>
      originalSelected && simulated
        ? createSimulatedReviewDetail(
            originalSelected,
            scope.userId,
            currentUserName
          )
        : emptyDetail,
    [originalSelected, simulated, scope.userId, currentUserName]
  )
  const groups = new Map<string, Array<Review>>()
  for (const review of visible) {
    const group = reviewGroup(review, display.groupBy, scope.userId)
    groups.set(group, [...(groups.get(group) ?? []), review])
  }
  function updateDisplay(next: ReviewDisplay) {
    if (!sync.save({ ...sync.value, display: next })) setSaveError(true)
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
        if (event.key === "Escape") closeReview()
        if (
          ["j", "k", "ArrowDown", "ArrowUp"].includes(event.key) &&
          visible.length
        ) {
          event.preventDefault()
          const direction =
            event.key === "j" || event.key === "ArrowDown" ? 1 : -1
          const index = visible.findIndex((review) => review.id === selectedId)
          const next =
            index < 0
              ? direction > 0
                ? 0
                : visible.length - 1
              : Math.max(0, Math.min(visible.length - 1, index + direction))
          navigate({ review: visible[next].id })
        }
      }}
    >
      {(!expanded || !selected) && (
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
                entries={effectiveEntries}
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
              activeOptions={{ exact: true, includeSearch: false }}
              className={pageTabClass}
              aria-current={view === "for-you" ? "page" : undefined}
            >
              For you
            </Link>
            <Link
              to="/reviews/created"
              activeOptions={{ exact: true, includeSearch: false }}
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
                  <h2 className="mb-0.5">
                    <button
                      aria-expanded={!collapsedGroups.includes(group)}
                      onClick={() =>
                        setCollapsedGroups(
                          collapsedGroups.includes(group)
                            ? collapsedGroups.filter((value) => value !== group)
                            : [...collapsedGroups, group]
                        )
                      }
                      className="flex h-7 w-full items-center gap-2 rounded-md bg-muted/35 px-2 text-left text-xs font-medium text-muted-foreground"
                    >
                      <span>{group}</span>
                      <HugeiconsIcon
                        icon={
                          collapsedGroups.includes(group)
                            ? ArrowRight01Icon
                            : ArrowDown01Icon
                        }
                        aria-hidden="true"
                        className="size-3 shrink-0 opacity-50"
                      />
                      <span className="ml-auto text-[10px] opacity-50">
                        {reviews.length}
                      </span>
                    </button>
                  </h2>
                )}
                {!collapsedGroups.includes(group) &&
                  reviews.map((review) => (
                    <button
                      key={review.id}
                      aria-pressed={selected?.id === review.id}
                      onClick={() => navigate({ review: review.id })}
                      className={cn(
                        "mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                        selected?.id === review.id && "bg-muted/70"
                      )}
                    >
                      <ReviewStatusIcon status={review.status} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px]">
                          {review.title}
                        </span>
                        {display.properties.some(
                          (property) => property !== "timestamp"
                        ) && (
                          <span className="mt-0.5 flex flex-wrap gap-x-1.5 text-[10px] text-muted-foreground">
                            {display.properties.includes("repository") && (
                              <span>{review.repository}</span>
                            )}
                            {display.properties.includes("id") && (
                              <span>#{review.number}</span>
                            )}
                            {display.properties.includes("author") && (
                              <span>{review.author.name}</span>
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
                        )}
                      </span>
                      {display.properties.includes("timestamp") && (
                        <time
                          dateTime={review.updatedAt}
                          title={new Date(review.updatedAt).toLocaleString()}
                          className="shrink-0 text-[11px] text-muted-foreground"
                        >
                          {relativeTime(review.updatedAt, now)}
                        </time>
                      )}
                    </button>
                  ))}
              </Fragment>
            ))}
            {!visible.length && !hasReviewFilters(filters) && (
              <IllustratedEmptyState
                kind="reviews"
                align="center"
                className="flex-none md:hidden"
              >
                <p>Nothing to review</p>
              </IllustratedEmptyState>
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
        </InboxSidebar>
      )}
      <section
        aria-label="Review details"
        className={cn(
          "@container/review min-h-0 min-w-0 flex-1 flex-col",
          selected ? "flex" : "hidden md:flex"
        )}
      >
        {selected ? (
          <ReviewDetail
            key={selected.id}
            review={selected}
            detail={selectedDetail}
            edit={edits[selected.id] ?? emptyReviewEdit()}
            mutable={simulated}
            userName={currentUserName}
            userId={scope.userId}
            tab={currentSelection.tab ?? "overview"}
            onTabChange={(tab) =>
              navigate({
                review: selected.id,
                ...(tab === "diff" ? { tab } : {}),
              })
            }
            onChange={(changes) => updateReview(selected.id, changes)}
            onClose={closeReview}
            expanded={expanded}
            onExpandedChange={setExpanded}
            selectedFile={currentSelection.file}
            onSelectFile={(file) =>
              navigate({ review: selected.id, tab: "diff", file })
            }
            onCopy={copy}
            onOpenAgent={onOpenAgent ? () => onOpenAgent(selected) : undefined}
          />
        ) : (
          <IllustratedEmptyState kind="reviews" align="center">
            <p>
              {entries.length
                ? visible.length
                  ? `${visible.length} review${visible.length === 1 ? "" : "s"}`
                  : hasReviewFilters(filters)
                    ? "No matching reviews"
                    : "Nothing to review"
                : "Nothing to review"}
            </p>
          </IllustratedEmptyState>
        )}
      </section>
      {saveError && (
        <p
          role="alert"
          className="absolute right-4 bottom-4 left-4 rounded-lg border border-destructive/30 bg-background px-4 py-3 text-xs text-destructive"
        >
          Changes apply for now but could not be saved.
        </p>
      )}
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </main>
  )
}
function Cancel01IconComponent() {
  return <HugeiconsIcon icon={Cancel01Icon} className="size-3" />
}

function relativeTime(date: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(date)) / 60000))
  return minutes < 1
    ? "now"
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(minutes / 1440)}d`
}
