import { useEffect, useRef, useState } from "react"
import type {
  InactiveIssue,
  InactiveIssuePage,
  IssueLifecycleInput,
} from "@/lib/issue-lifecycle-contract"
import {
  canonicalIssueEpoch,
  canonicalIssueState,
  removeCanonicalIssueRecords,
  restoreCanonicalIssueVisibility,
  suppressCanonicalIssueRecord,
} from "@/lib/canonical-issue-cache"
import {
  loadInactiveIssues,
  persistIssueLifecycle,
} from "@/lib/issue-lifecycle-state"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

export function useIssueLifecycle() {
  const [pending, setPending] = useState(false),
    [error, setError] = useState("")
  const retry = useRef<IssueLifecycleInput | undefined>(undefined)
  const busy = useRef(false)
  const request = useRef(0)
  const identity = canonicalIssueState(),
    epoch = canonicalIssueEpoch()
  useEffect(() => {
    request.current++
    retry.current = undefined
    busy.current = false
    setPending(false)
    setError("")
    return () => {
      request.current++
    }
  }, [epoch, identity?.workspaceId, identity?.userId, identity?.sessionId])
  async function change(input: Omit<IssueLifecycleInput, "commandKey">) {
    if (!identity || busy.current) return false
    const command =
      retry.current &&
      JSON.stringify({ ...retry.current, commandKey: undefined }) ===
        JSON.stringify(input)
        ? retry.current
        : { ...input, commandKey: crypto.randomUUID() }
    retry.current = command
    busy.current = true
    setPending(true)
    setError("")
    const token = ++request.current
    const active = () =>
      token === request.current &&
      epoch === canonicalIssueEpoch() &&
      canonicalIssueState()?.sessionId === identity.sessionId
    try {
      const result = JSON.parse(
        await persistIssueLifecycle({
          data: {
            ...command,
            workspaceId: identity.workspaceId,
            sessionId: identity.sessionId,
          },
        })
      ) as { status: string; value?: { revision: number; active?: boolean } }
      if (!active()) return false
      if (result.status === "conflict") {
        retry.current = undefined
        setError(
          "This issue changed. Reload and review it before trying again."
        )
        return false
      }
      retry.current = undefined
      if (result.value?.active !== undefined)
        restoreCanonicalIssueVisibility(
          input.issueId,
          result.value.revision,
          result.value.active
        )
      else if (
        (input.action === "delete" || input.action === "archive") &&
        result.value
      )
        suppressCanonicalIssueRecord(input.issueId, result.value.revision)
      else removeCanonicalIssueRecords([input.issueId])
      window.dispatchEvent(new Event("forge:issue-queries-invalidated"))
      return true
    } catch (caught) {
      if (active())
        setError(
          caught instanceof Error
            ? caught.message
            : "The change could not be saved. Retry to check its outcome."
        )
      return false
    } finally {
      if (token === request.current) busy.current = false
      if (active()) setPending(false)
    }
  }
  return { change, pending, error }
}

export function IssueRecovery({ teamId }: { teamId: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>
        Archived and deleted
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Archived and deleted issues</DialogTitle>
        <DialogDescription>
          Deleted issues can be restored for 30 days. Restoring an active issue
          uses your workspace’s issue capacity.
        </DialogDescription>
        {open && <RecoveryList teamId={teamId} />}
      </DialogContent>
    </Dialog>
  )
}
function RecoveryList({ teamId }: { teamId: string }) {
  const [kind, setKind] = useState<"deleted" | "archived">("deleted"),
    [page, setPage] = useState<InactiveIssuePage>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false)
  const [pageScope, setPageScope] = useState("")
  const [deleting, setDeleting] = useState<InactiveIssue>()
  const operation = useIssueLifecycle(),
    request = useRef(0)
  const identity = canonicalIssueState(),
    epoch = canonicalIssueEpoch()
  const scope = `${epoch}:${identity?.workspaceId}:${identity?.userId}:${identity?.sessionId}`
  const visiblePage = pageScope === `${scope}:${kind}` ? page : undefined
  async function refresh(after?: string) {
    if (!identity) return
    const token = ++request.current
    setLoading(true)
    setError("")
    setDeleting(undefined)
    if (!after) setPage(undefined)
    try {
      const next = JSON.parse(
        await loadInactiveIssues({
          data: {
            teamId,
            kind,
            after,
            workspaceId: identity.workspaceId,
            sessionId: identity.sessionId,
          },
        })
      ) as InactiveIssuePage
      if (token === request.current && epoch === canonicalIssueEpoch()) {
        setPageScope(`${scope}:${kind}`)
        setPage((previous) => ({
          ...next,
          items: after
            ? [...(previous?.items ?? []), ...next.items]
            : next.items,
        }))
      }
    } catch {
      if (token === request.current)
        setError("Issues could not be loaded. Reload to try again.")
    } finally {
      if (token === request.current) setLoading(false)
    }
  }
  useEffect(() => {
    void refresh()
    const reload = () => void refresh()
    window.addEventListener("focus", reload)
    window.addEventListener("forge:issue-queries-invalidated", reload)
    return () => {
      request.current++
      window.removeEventListener("focus", reload)
      window.removeEventListener("forge:issue-queries-invalidated", reload)
    }
  }, [teamId, kind, scope])
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {(["deleted", "archived"] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={kind === value ? "secondary" : "ghost"}
            onClick={() => setKind(value)}
          >
            {value === "deleted" ? "Deleted" : "Archived"}
          </Button>
        ))}
      </div>
      {(error || operation.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error || operation.error}
        </p>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={loading || operation.pending}
        onClick={() => void refresh()}
      >
        Reload
      </Button>
      <div className="max-h-80 space-y-3 overflow-y-auto">
        {visiblePage?.items.map((issue) => (
          <div
            key={issue.id}
            className="flex items-center gap-3 rounded-lg border p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">
                #{issue.number} · {issue.title}
              </p>
              {issue.recoverUntil && (
                <p className="text-xs text-muted-foreground">
                  Recover before {new Date(issue.recoverUntil).toLocaleString()}
                  {issue.archivedAt ? " · Restores to archive" : ""}
                </p>
              )}
            </div>
            <Button
              size="sm"
              disabled={operation.pending}
              onClick={async () => {
                if (
                  await operation.change({
                    teamId,
                    issueId: issue.id,
                    expectedRevision: issue.revision,
                    action: kind === "deleted" ? "restore" : "unarchive",
                  })
                )
                  await refresh()
              }}
            >
              {kind === "deleted" ? "Restore" : "Unarchive"}
            </Button>
            {kind === "archived" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={operation.pending}
                onClick={() => setDeleting(issue)}
              >
                Delete
              </Button>
            )}
          </div>
        ))}
      </div>
      {deleting &&
        visiblePage?.items.some((issue) => issue.id === deleting.id) && (
          <div className="space-y-2 rounded-lg border p-3">
            <p className="text-sm">
              Delete #{deleting.number} · {deleting.title}? You can restore it
              for 30 days.
            </p>
            <Button
              variant="destructive"
              size="sm"
              disabled={operation.pending}
              onClick={async () => {
                if (
                  await operation.change({
                    teamId,
                    issueId: deleting.id,
                    expectedRevision: deleting.revision,
                    action: "delete",
                  })
                )
                  await refresh()
              }}
            >
              Delete issue
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={operation.pending}
              onClick={() => setDeleting(undefined)}
            >
              Cancel
            </Button>
          </div>
        )}
      {loading && (
        <p role="status" className="text-sm">
          Loading…
        </p>
      )}
      {visiblePage && !visiblePage.items.length && (
        <p className="text-sm text-muted-foreground">No {kind} issues.</p>
      )}
      {visiblePage?.nextCursor && (
        <Button
          disabled={loading}
          onClick={() => void refresh(visiblePage.nextCursor!)}
        >
          Load more
        </Button>
      )}
    </div>
  )
}
