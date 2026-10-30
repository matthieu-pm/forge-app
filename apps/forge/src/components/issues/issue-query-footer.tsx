import type { useIssueQuery } from "@/lib/issue-query-client"
import { Button } from "@/components/ui/button"

export function IssueQueryFooter({
  query,
}: {
  query: ReturnType<typeof useIssueQuery>
}) {
  if (!query.enabled) return null
  return (
    <div
      className="flex shrink-0 items-center justify-center gap-3 px-3 py-2 text-xs text-muted-foreground"
      aria-live="polite"
    >
      {query.error ? (
        <>
          <span role="alert">{query.error}</span>
          <Button size="sm" variant="ghost" onClick={query.refresh}>
            Retry
          </Button>
        </>
      ) : (
        <>
          <span>
            {query.loading
              ? "Loading issues…"
              : `${query.records.length} of ${query.page?.total ?? 0} issues`}
          </span>
          {query.page?.nextCursor && (
            <Button
              size="sm"
              variant="ghost"
              disabled={query.loading}
              onClick={query.loadMore}
            >
              Load more
            </Button>
          )}
          {!query.loading && (
            <Button size="sm" variant="ghost" onClick={query.refresh}>
              Refresh
            </Button>
          )}
          {query.page?.facetsTruncated && (
            <span>
              Some breakdowns are limited. Refine filters for more detail.
            </span>
          )}
        </>
      )}
    </div>
  )
}
