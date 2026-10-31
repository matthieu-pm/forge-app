import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { ActivityRow } from "./issue-activity-row"
import type {
  IssueHistoryEntry,
  IssueHistoryPage,
} from "@/lib/issue-history-contract"
import {
  CANONICAL_ISSUES_CHANGED,
  canonicalIssueEpoch,
  canonicalIssueState,
} from "@/lib/canonical-issue-cache"
import { loadIssueHistory } from "@/lib/issue-history-state"
import { Button } from "@/components/ui/button"

function subscribe(listener: () => void) {
  window.addEventListener(CANONICAL_ISSUES_CHANGED, listener)
  return () => window.removeEventListener(CANONICAL_ISSUES_CHANGED, listener)
}
function scope() {
  const state = canonicalIssueState()
  return `${canonicalIssueEpoch()}:${state?.workspaceId}:${state?.userId}:${state?.sessionId}`
}
export function historyAction(entry: IssueHistoryEntry) {
  if (entry.origin === "import")
    return "imported the issue (historical attribution unverified)"
  const actions: Record<string, string> = {
    "issue.created": "created the issue",
    "issue.updated": "updated the issue",
    "issue.comment.created": "added a comment",
    "issue.comment.edited": "edited a comment",
    "issue.comment.deleted": "deleted a comment",
    "issue.comment.restored": "restored a comment",
    "issue.delete": "deleted the issue",
    "issue.restore": "restored the issue",
    "issue.archive": "archived the issue",
    "issue.unarchive": "unarchived the issue",
    "issue.relationship-changed": "changed issue relationships",
  }
  return actions[entry.topic] ?? "changed the issue"
}
export function IssueHistory({
  issueId,
  revision,
  valueLabel = (_field, value) => value,
}: {
  issueId: string
  revision: number
  valueLabel?: (field: string, value: string) => string
}) {
  const identityScope = useSyncExternalStore(subscribe, scope, () => "")
  const [refresh, setRefresh] = useState(0)
  const key = `${identityScope}:${issueId}:${revision}:${refresh}`
  const [state, setState] = useState<{
    key: string
    page?: IssueHistoryPage
    loading: boolean
    error?: string
  }>()
  const active = useRef(key)
  active.current = key
  const pending = useRef(false)
  const sequence = useRef(0)
  const page = state?.key === key ? state.page : undefined
  const error = state?.key === key ? state.error : undefined
  const loading = state?.key !== key || state.loading
  async function request(more: boolean) {
    const identity = canonicalIssueState(),
      epoch = canonicalIssueEpoch(),
      requestKey = key
    if (!identity || (more && pending.current)) return
    const requestSequence = ++sequence.current
    pending.current = true
    setState({ key, page: more ? page : undefined, loading: true })
    try {
      const result = await loadIssueHistory({
        data: {
          workspaceId: identity.workspaceId,
          sessionId: identity.sessionId,
          query: {
            issueId,
            ...(more && page?.nextCursor ? { cursor: page.nextCursor } : {}),
          },
        },
      })
      if (
        active.current !== requestKey ||
        canonicalIssueEpoch() !== epoch ||
        sequence.current !== requestSequence
      )
        return
      setState({
        key,
        loading: false,
        page: {
          ...result,
          entries:
            more && page
              ? [
                  ...new Map(
                    [...page.entries, ...result.entries].map((e) => [e.id, e])
                  ).values(),
                ]
              : result.entries,
        },
      })
    } catch {
      if (
        active.current === requestKey &&
        canonicalIssueEpoch() === epoch &&
        sequence.current === requestSequence
      )
        setState({
          key,
          loading: false,
          error: "History could not be loaded. Refresh to try again.",
        })
    } finally {
      if (active.current === requestKey && sequence.current === requestSequence)
        pending.current = false
    }
  }
  useEffect(() => {
    active.current = key
    void request(false)
    return () => {
      if (active.current === key) {
        active.current = ""
        sequence.current++
      }
    }
  }, [key])
  return (
    <div aria-label="Committed issue history" className="mb-6 space-y-4">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>Committed history</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setRefresh((n) => n + 1)}
        >
          Refresh history
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {page?.nextCursor && (
        <Button
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => void request(true)}
        >
          Load older history
        </Button>
      )}
      {loading && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading history…
        </p>
      )}
      {page && !page.entries.length && (
        <p className="text-xs text-muted-foreground">
          No committed history is available for this issue.
        </p>
      )}
      {[...(page?.entries ?? [])].reverse().map((entry) => (
        <ActivityRow key={entry.id} id={`history-${entry.id}`}>
          <p className="min-w-0 break-words">
            <span className="font-medium text-foreground">
              {entry.actor.name}
            </span>
            {entry.actor.kind === "agent"
              ? " via agent"
              : entry.actor.kind === "apiKey"
                ? " via API key"
                : ""}{" "}
            {historyAction(entry)}
            {entry.changes.map((change, i) => (
              <span key={i}>
                {i ? "; " : ": "}
                {change.field.replace(/([A-Z])/g, " $1").toLowerCase()}
                {(change.from || change.to) && (
                  <>
                    {" "}
                    from {valueLabel(change.field, change.from) ||
                      "none"} to {valueLabel(change.field, change.to) || "none"}
                  </>
                )}
              </span>
            ))}
            {" · "}
            <a href={`#history-${entry.id}`} className="hover:underline">
              <time
                dateTime={entry.createdAt}
                title={new Date(entry.createdAt).toLocaleString()}
              >
                {new Date(entry.createdAt).toLocaleString()}
              </time>
            </a>
            {entry.commentId && (
              <>
                {" "}
                ·{" "}
                <a
                  className="hover:underline"
                  href={`#comment-${entry.commentId}`}
                >
                  View comment
                </a>
              </>
            )}
          </p>
        </ActivityRow>
      ))}
    </div>
  )
}
