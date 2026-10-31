import { useEffect, useState, useSyncExternalStore } from "react"
import { z } from "zod"
import {
  CANONICAL_ISSUES_CHANGED,
  canonicalIssueEpoch,
  canonicalIssueRows,
  canonicalIssueState,
  canonicalIssuesActive,
  mergeCanonicalIssueRecords,
  removeCanonicalIssueRecords,
} from "./canonical-issue-cache"
import { loadIssueDetail, loadIssueQuery } from "./canonical-issue-state"
import { issueQuerySchema } from "./issue-query-contract"
import { DEFINITIONS_CHANGED } from "./issue-definition-cache"
import type { IssueQuery, IssueQueryPage } from "./issue-query-contract"

export const ISSUE_QUERIES_INVALIDATED = "forge:issue-queries-invalidated"
type Entry = {
  query: IssueQuery
  page?: IssueQueryPage
  loading: boolean
  error: string
}
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
let version = 0
let generation = 0
function notify() {
  version++
  for (const listener of listeners) listener()
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  window.addEventListener(CANONICAL_ISSUES_CHANGED, listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener(CANONICAL_ISSUES_CHANGED, listener)
  }
}
function snapshot() {
  const state = canonicalIssueState()
  return `${version}:${canonicalIssueEpoch()}:${canonicalIssuesActive()}:${state?.workspaceId}:${state?.userId}:${state?.sessionId}`
}
export function invalidateIssueQueries(teamIds?: Array<string>) {
  generation++
  for (const [key, entry] of entries) {
    if (
      !teamIds ||
      !entry.query.teamIds ||
      entry.query.teamIds.some((id) => teamIds.includes(id))
    )
      entries.delete(key)
  }
  notify()
}
if (typeof window !== "undefined") {
  window.addEventListener(DEFINITIONS_CHANGED, () => invalidateIssueQueries())
  window.addEventListener(ISSUE_QUERIES_INVALIDATED, (event) => {
    invalidateIssueQueries(
      (event as Event & { detail?: { teamIds?: Array<string> } }).detail
        ?.teamIds
    )
  })
}
async function requestPage(key: string, entry: Entry, more: boolean) {
  const identity = canonicalIssueState()
  if (!identity || entry.loading) return
  entry.loading = true
  entry.error = ""
  notify()
  try {
    const page = JSON.parse(
      await loadIssueQuery({
        data: {
          workspaceId: identity.workspaceId,
          sessionId: identity.sessionId,
          query: {
            ...entry.query,
            ...(more && entry.page?.nextCursor
              ? { cursor: entry.page.nextCursor }
              : {}),
          },
        },
      })
    ) as IssueQueryPage
    const current = canonicalIssueState()
    if (
      entries.get(key) !== entry ||
      current?.workspaceId !== page.workspaceId ||
      current.userId !== page.userId ||
      current.sessionId !== page.sessionId
    )
      return
    if (
      more &&
      entry.page &&
      entry.page.resultRevision !== page.resultRevision
    ) {
      const previous = entry.page.records
      removeCanonicalIssueRecords(previous.map((r) => r.issue.id))
      // Re-read the first page if edits or access changes altered this traversal.
      // A normal concurrent create is outside the cursor's creation cutoff.
      invalidateIssueQueries([...new Set(previous.map((r) => r.teamId))])
      return
    }
    const records =
      more && entry.page
        ? [
            ...new Map(
              [...entry.page.records, ...page.records].map((r) => [
                r.issue.id,
                r,
              ])
            ).values(),
          ]
        : page.records
    entry.page = { ...page, records }
    mergeCanonicalIssueRecords(page.records, false)
  } catch {
    if (entries.get(key) === entry) {
      // Never keep protected rows after an authorization/refresh failure.
      removeCanonicalIssueRecords(
        entry.page?.records.map((r) => r.issue.id) ?? []
      )
      entry.page = undefined
      entry.error = "Issues could not be loaded. Refresh to try again."
    }
  } finally {
    entry.loading = false
    if (entries.get(key) === entry) notify()
  }
}
export function useIssueQuery(input: IssueQuery) {
  useSyncExternalStore(subscribe, snapshot, () => "")
  const identity = canonicalIssueState()
  const enabled = canonicalIssuesActive() && Boolean(identity)
  const parsed = issueQuerySchema.safeParse(input)
  const serialized = parsed.success ? JSON.stringify(parsed.data) : "invalid"
  const key = enabled
    ? `${canonicalIssueEpoch()}:${identity!.workspaceId}:${identity!.userId}:${identity!.sessionId}:${serialized}`
    : ""
  const entry = entries.get(key)
  useEffect(() => {
    if (!key || serialized === "invalid" || entries.has(key)) return
    const next: Entry = {
      query: JSON.parse(serialized),
      loading: false,
      error: "",
    }
    // Retain at most 30 query variants; only explicitly requested pages are loaded.
    if (entries.size >= 30) entries.delete(entries.keys().next().value!)
    entries.set(key, next)
    void requestPage(key, next, false)
  }, [key, serialized, version])
  const records =
    entry?.page?.records.map((r) => ({
      ...r,
      issue:
        canonicalIssueRows(r.teamId).find((v) => v.issue.id === r.issue.id)
          ?.issue ?? r.issue,
    })) ?? []
  return {
    enabled,
    records,
    page: entry?.page,
    loading: enabled && (!entry || entry.loading),
    error:
      serialized === "invalid"
        ? "These issue filters exceed the supported query limits."
        : (entry?.error ?? ""),
    loadMore: () => {
      if (entry?.page?.nextCursor) void requestPage(key, entry, true)
    },
    refresh: () => {
      entries.delete(key)
      notify()
    },
  }
}

/** Direct links resolve one ID even when it is absent from the current page. */
export function useQueriedIssue(id?: string) {
  useSyncExternalStore(subscribe, snapshot, () => "")
  const state = canonicalIssueState()
  const scope = state
    ? `${canonicalIssueEpoch()}:${state.workspaceId}:${state.userId}:${state.sessionId}`
    : ""
  const invalidation = generation
  // Refreshing the same authorized detail must not unmount its private editor
  // or cancel selected uploads. Identity/ID changes still hide it immediately;
  // an empty or failed revalidation clears it when that response arrives.
  const key = `${scope}:${id}`
  const [result, setResult] = useState<{
    key: string
    record?: IssueQueryPage["records"][number]
  }>()
  useEffect(() => {
    if (!state || !id || !z.uuid().safeParse(id).success) return
    let active = true
    const epoch = canonicalIssueEpoch()
    void loadIssueDetail({
      data: { workspaceId: state.workspaceId, sessionId: state.sessionId, id },
    })
      .then((raw) => {
        const current = canonicalIssueState()
        if (
          !active ||
          epoch !== canonicalIssueEpoch() ||
          generation !== invalidation ||
          current?.sessionId !== state.sessionId ||
          current.userId !== state.userId ||
          current.workspaceId !== state.workspaceId
        )
          return
        const records = JSON.parse(raw) as IssueQueryPage["records"]
        if (!records.length) removeCanonicalIssueRecords([id])
        mergeCanonicalIssueRecords(records, false)
        setResult({ key, record: records[0] })
      })
      .catch(() => {
        if (active) setResult({ key })
      })
    return () => {
      active = false
    }
  }, [id, scope, invalidation])
  const record = result?.key === key ? result.record : undefined
  return record
    ? (canonicalIssueRows(record.teamId).find(
        (r) => r.issue.id === record.issue.id
      ) ?? record)
    : undefined
}
