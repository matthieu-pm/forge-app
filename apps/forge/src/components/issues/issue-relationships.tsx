import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { IssueIcon } from "./issue-controls"
import type { TeamIssue } from "@/lib/issue-record-contract"
import type { CanonicalSnapshot } from "@/lib/canonical-issue-cache"
import type {
  ChangeIssueRelationship,
  IssueRelationshipKind,
  IssueRelationshipPage,
  RelationshipIssue,
} from "@/lib/issue-relationship-contract"
import {
  changeRelationshipSchema,
  relationshipLabels,
} from "@/lib/issue-relationship-contract"
import {
  canonicalIssueEpoch,
  canonicalIssueState,
  mergeCanonicalIssueRecords,
} from "@/lib/canonical-issue-cache"
import {
  loadIssueRelationships,
  persistIssueRelationship,
  searchIssueRelationships,
} from "@/lib/issue-relationship-state"
import { productStorage, saveProductValue } from "@/lib/product-storage"
import { Button } from "@/components/ui/button"

type Draft = {
  input: ChangeIssueRelationship
  conflict?: boolean
  rejected?: boolean
}
type SearchPage = {
  issues: Array<RelationshipIssue>
  nextCursor: string | null
}

/** Detail-owned queries also work for issues outside the current list page. */
export function IssueRelationships({
  issue,
  teamId,
}: {
  issue: TeamIssue
  teamId: string
}) {
  const identity = canonicalIssueState()
  const epoch = canonicalIssueEpoch()
  const request = useRef(0)
  const scope = `${epoch}:${identity?.workspaceId}:${identity?.userId}:${identity?.sessionId}`
  const key = `forge:team-relationship-draft:v1:${teamId}:${issue.id}`
  const [page, setPage] = useState<IssueRelationshipPage>()
  const [error, setError] = useState("")
  const [readError, setReadError] = useState("")
  const [draftTarget, setDraftTarget] = useState<RelationshipIssue>()
  const searchRequest = useRef(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const busy = useRef(false)
  const mounted = useRef(true)
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<IssueRelationshipKind>("related")
  const [search, setSearch] = useState("")
  const [searchPage, setSearchPage] = useState<SearchPage>()
  const [searchError, setSearchError] = useState("")
  const [searchLoading, setSearchLoading] = useState(false)
  const [target, setTarget] = useState<RelationshipIssue>()
  const [draft, setDraft] = useState<Draft | undefined>(() => {
    try {
      const stored = JSON.parse(productStorage.getItem(key) ?? "null")
      return stored
        ? {
            input: changeRelationshipSchema.parse(stored.input),
            conflict: stored.conflict === true,
            rejected: stored.rejected === true,
          }
        : undefined
    } catch {
      return undefined
    }
  })
  function active() {
    const current = canonicalIssueState()
    return (
      mounted.current &&
      epoch === canonicalIssueEpoch() &&
      identity &&
      current?.workspaceId === identity.workspaceId &&
      current.userId === identity.userId &&
      current.sessionId === identity.sessionId
    )
  }
  async function refresh(cursor?: string) {
    if (!identity) return
    const token = ++request.current
    setLoading(true)
    try {
      const next = JSON.parse(
        await loadIssueRelationships({
          data: {
            workspaceId: identity.workspaceId,
            sessionId: identity.sessionId,
            issueId: issue.id,
            cursor,
          },
        })
      ) as IssueRelationshipPage
      if (!active() || token !== request.current) return
      setPage((previous) => ({
        ...next,
        relationships:
          cursor && previous
            ? [...previous.relationships, ...next.relationships].filter(
                (r, i, all) =>
                  all.findIndex(
                    (x) => x.kind === r.kind && x.issue.id === r.issue.id
                  ) === i
              )
            : next.relationships,
      }))
      setReadError("")
    } catch {
      if (active() && token === request.current) {
        setPage(undefined)
        setReadError("Relationships could not be loaded. Reload to try again.")
      }
    } finally {
      if (active() && token === request.current) setLoading(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    void refresh()
    const reload = () => {
      void refresh()
    }
    window.addEventListener("focus", reload)
    window.addEventListener("forge:issue-queries-invalidated", reload)
    return () => {
      mounted.current = false
      window.removeEventListener("focus", reload)
      window.removeEventListener("forge:issue-queries-invalidated", reload)
    }
  }, [issue.id, issue.revision, scope])
  useEffect(() => {
    if (!open || !identity) return
    let current = true
    const token = ++searchRequest.current
    setSearchPage(undefined)
    setTarget(undefined)
    setSearchLoading(true)
    setSearchError("")
    const timer = window.setTimeout(() => {
      void searchIssueRelationships({
        data: {
          workspaceId: identity.workspaceId,
          sessionId: identity.sessionId,
          issueId: issue.id,
          search,
        },
      })
        .then((raw) => {
          if (current && active() && token === searchRequest.current)
            setSearchPage(JSON.parse(raw) as SearchPage)
        })
        .catch(() => {
          if (current && active() && token === searchRequest.current)
            setSearchError("Issues could not be searched. Try again.")
        })
        .finally(() => {
          if (current && active() && token === searchRequest.current)
            setSearchLoading(false)
        })
    }, 250)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [open, search, scope, issue.id])
  useEffect(() => {
    setDraftTarget(undefined)
    if (!draft || !identity) return
    let current = true
    void loadIssueRelationships({
      data: {
        workspaceId: identity.workspaceId,
        sessionId: identity.sessionId,
        issueId: draft.input.targetId,
        limit: 1,
      },
    })
      .then((raw) => {
        if (current && active())
          setDraftTarget((JSON.parse(raw) as IssueRelationshipPage).issue)
      })
      .catch(() => {
        /* The draft retains its input without disclosing a revoked target. */
      })
    return () => {
      current = false
    }
  }, [draft?.input.targetId, scope])
  async function moreSearch() {
    if (!identity || !searchPage?.nextCursor || searchLoading) return
    const token = searchRequest.current
    setSearchLoading(true)
    try {
      const next = JSON.parse(
        await searchIssueRelationships({
          data: {
            workspaceId: identity.workspaceId,
            sessionId: identity.sessionId,
            issueId: issue.id,
            search,
            after: searchPage.nextCursor,
          },
        })
      ) as SearchPage
      if (active() && token === searchRequest.current)
        setSearchPage({
          ...next,
          issues: [
            ...new Map(
              [...searchPage.issues, ...next.issues].map((value) => [
                value.id,
                value,
              ])
            ).values(),
          ],
        })
    } catch {
      if (active())
        setSearchError("More issues could not be loaded. Try again.")
    } finally {
      if (active()) setSearchLoading(false)
    }
  }
  async function submit(next: Draft) {
    if (!identity || busy.current) return
    busy.current = true
    setSaving(true)
    setDraft(next)
    setError("")
    try {
      // Preserve the exact command before dispatch; uncertain responses replay it.
      await saveProductValue(key, JSON.stringify(next))
      if (!active()) return
      const result = JSON.parse(
        await persistIssueRelationship({
          data: {
            ...next.input,
            workspaceId: identity.workspaceId,
            sessionId: identity.sessionId,
          },
        })
      ) as {
        status: "saved" | "conflict" | "invalid"
        message?: string
        records?: CanonicalSnapshot["records"]
      }
      if (!active()) return
      if (result.status === "invalid") {
        const retained = { ...next, rejected: true }
        setDraft(retained)
        await saveProductValue(key, JSON.stringify(retained))
        if (active()) setError(result.message ?? "Choose another relationship.")
        return
      }
      mergeCanonicalIssueRecords(result.records ?? [])
      if (result.status === "conflict") {
        const retained = { ...next, conflict: true }
        setDraft(retained)
        await saveProductValue(key, JSON.stringify(retained))
        if (active())
          setError(
            "An issue changed in another session. Review the latest relationships before applying your change."
          )
      } else {
        await saveProductValue(key, null)
        if (!active()) return
        setDraft(undefined)
        setTarget(undefined)
        setOpen(false)
      }
      await refresh()
    } catch (failure) {
      if (active())
        setError(
          failure instanceof Error &&
            !/^(\[|Failed query|SQL)/.test(failure.message)
            ? failure.message
            : "The change could not be confirmed. Your saved change is available to retry."
        )
    } finally {
      busy.current = false
      if (active()) setSaving(false)
    }
  }
  function change(
    relationshipKind: IssueRelationshipKind,
    selected: RelationshipIssue,
    action: "add" | "remove"
  ) {
    if (!page || draft || busy.current) return
    void submit({
      input: {
        commandKey: crypto.randomUUID(),
        issueId: issue.id,
        expectedRevision: page.issue.revision,
        targetId: selected.id,
        expectedTargetRevision: selected.revision,
        kind: relationshipKind,
        action,
      },
    })
  }
  async function rebase() {
    if (!draft?.conflict || !identity || busy.current) return
    try {
      const source = JSON.parse(
        await loadIssueRelationships({
          data: {
            workspaceId: identity.workspaceId,
            sessionId: identity.sessionId,
            issueId: issue.id,
          },
        })
      ) as IssueRelationshipPage
      const targetPage = JSON.parse(
        await loadIssueRelationships({
          data: {
            workspaceId: identity.workspaceId,
            sessionId: identity.sessionId,
            issueId: draft.input.targetId,
          },
        })
      ) as IssueRelationshipPage
      if (active())
        await submit({
          input: {
            ...draft.input,
            commandKey: crypto.randomUUID(),
            expectedRevision: source.issue.revision,
            expectedTargetRevision: targetPage.issue.revision,
          },
        })
    } catch {
      if (active())
        setError(
          "The latest issues could not be loaded. Your change is retained."
        )
    }
  }
  async function discard() {
    if (saving || !draft || !identity) return
    try {
      // Dropping a draft never reverses an already committed relationship.
      const latest = JSON.parse(
        await loadIssueRelationships({
          data: {
            workspaceId: identity.workspaceId,
            sessionId: identity.sessionId,
            issueId: issue.id,
          },
        })
      ) as IssueRelationshipPage
      if (!active()) return
      await saveProductValue(key, null)
      if (active()) {
        setPage(latest)
        setDraft(undefined)
        setError("")
      }
    } catch {
      if (active())
        setError("The saved change could not be cleared. Try again.")
    }
  }
  return (
    <section aria-label="Issue relationships" className="mb-5 text-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs text-muted-foreground">Relationships</h3>
        <Button
          size="sm"
          variant="ghost"
          disabled={saving || Boolean(draft)}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <IssueIcon name="add" /> Add relationship
        </Button>
      </div>
      {loading && !page && (
        <p role="status" className="text-xs text-muted-foreground">
          Loading relationships…
        </p>
      )}
      {page && page.relationships.length === 0 && (
        <p className="py-2 text-xs text-muted-foreground">
          No linked issues yet.
        </p>
      )}
      {page?.relationships.map((relation) => (
        <div
          key={`${relation.kind}:${relation.issue.id}`}
          className="flex items-center gap-2 border-b border-border/50 py-2"
        >
          <span className="w-20 shrink-0 text-xs text-muted-foreground">
            {relationshipLabels[relation.kind]}
          </span>
          <Link
            to="/teams/$teamSlug/issues"
            params={{ teamSlug: relation.issue.teamSlug }}
            search={{ view: "all", issue: relation.issue.id }}
            className="min-w-0 flex-1 truncate rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Open ${relation.issue.identifier}-${relation.issue.number} ${relation.issue.title}`}
          >
            <span className="mr-2 text-xs text-muted-foreground">
              {relation.issue.identifier}-{relation.issue.number}
            </span>
            {relation.issue.title}
          </Link>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={saving || Boolean(draft)}
            aria-label={`Remove ${relationshipLabels[relation.kind].toLowerCase()} ${relation.issue.identifier}-${relation.issue.number}`}
            onClick={() => change(relation.kind, relation.issue, "remove")}
          >
            <IssueIcon name="close" />
          </Button>
        </div>
      ))}
      {page?.nextCursor && (
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => void refresh(page.nextCursor!)}
        >
          Load more relationships
        </Button>
      )}
      {open && !draft && (
        <div className="mt-2 rounded-lg border border-border p-3">
          <label className="mb-2 flex items-center justify-between gap-2 text-xs">
            Relationship type
            <select
              aria-label="Relationship type"
              value={kind}
              onChange={(e) => setKind(e.target.value as IssueRelationshipKind)}
              className="rounded-md border border-border bg-background p-1.5"
            >
              {Object.entries(relationshipLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <input
            aria-label="Search relationship issues"
            placeholder="Search by title or issue ID…"
            value={search}
            maxLength={200}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div
            aria-label="Relationship issue results"
            className="my-2 max-h-52 overflow-y-auto"
          >
            {searchLoading && (
              <p role="status" className="p-2 text-xs text-muted-foreground">
                Searching issues…
              </p>
            )}
            {searchPage?.issues.map((candidate) => (
              <button
                type="button"
                key={candidate.id}
                aria-pressed={target?.id === candidate.id}
                className="flex w-full items-center gap-2 rounded-md p-2 text-left text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent"
                onClick={() => setTarget(candidate)}
              >
                <span className="shrink-0 text-muted-foreground">
                  {candidate.identifier}-{candidate.number}
                </span>
                <span className="truncate">{candidate.title}</span>
                {target?.id === candidate.id && (
                  <IssueIcon name="check" className="ml-auto" />
                )}
              </button>
            ))}
            {!searchLoading && searchPage?.issues.length === 0 && (
              <p className="p-2 text-xs text-muted-foreground">
                No matching issues.
              </p>
            )}
            {searchPage?.nextCursor && (
              <Button
                variant="ghost"
                size="sm"
                disabled={searchLoading}
                onClick={() => void moreSearch()}
              >
                Load more issues
              </Button>
            )}
          </div>
          {searchError && (
            <p role="alert" className="my-2 text-xs text-destructive">
              {searchError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!target || saving || !page}
              onClick={() => target && change(kind, target, "add")}
            >
              Link issue
            </Button>
          </div>
        </div>
      )}
      {readError && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {readError}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {draft && (
        <div className="mt-2 rounded-lg border border-border p-3 text-xs">
          <p>
            {saving
              ? "Saving relationship…"
              : `Saved change: ${draft.input.action === "add" ? "add" : "remove"} ${relationshipLabels[draft.input.kind].toLowerCase()} relationship${draftTarget ? ` with ${draftTarget.identifier}-${draftTarget.number}: ${draftTarget.title}` : ""}.`}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {draft.rejected ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => void discard()}
              >
                Choose another relationship
              </Button>
            ) : draft.conflict ? (
              <>
                <Button
                  size="sm"
                  disabled={saving}
                  onClick={() => void rebase()}
                >
                  Apply to latest
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => void discard()}
                >
                  Use latest relationships
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  disabled={saving}
                  onClick={() => void submit(draft)}
                >
                  Retry saved change
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => void discard()}
                >
                  Use latest relationships
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      {!loading && !page && (
        <Button variant="ghost" size="sm" onClick={() => void refresh()}>
          Reload relationships
        </Button>
      )}
    </section>
  )
}
