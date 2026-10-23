import { useCallback, useMemo, useSyncExternalStore } from "react"
import { z } from "zod"
import {
  defaultInboxPreferences,
  inboxPreferencesSchema,
  inboxStatusTypes,
} from "./inbox-view"
import type { InboxPreferences } from "./inbox-view"

export type InboxScope = { workspaceId: string; userId: string }
export const updateKinds = [
  "assignment",
  "mention",
  "comment",
  "status",
] as const
const issueSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  status: z.string(),
  statusType: z.enum(inboxStatusTypes).optional(),
  priority: z.string(),
  assignee: z.string().nullable(),
  project: z.string().nullable(),
})
const eventSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(updateKinds),
  actor: z.string(),
  actorId: z.string(),
  createdAt: z.string().datetime(),
  message: z.string(),
})
export const inboxUpdateSchema = eventSchema.extend({
  workspaceId: z.string(),
  issue: issueSchema,
  recipientIds: z.array(z.string()),
  subscriberIds: z.array(z.string()),
})
const entrySchema = z.object({
  id: z.string(),
  issue: issueSchema.nullable(),
  events: z.array(eventSchema),
  unread: z.boolean(),
  snoozedUntil: z.number().nullable(),
  deleted: z.boolean(),
})
const stateSchema = z.object({
  entries: z.array(entrySchema),
  unsubscribedIssueIds: z.array(z.string()),
  preferences: inboxPreferencesSchema.default(defaultInboxPreferences),
})
export type InboxUpdate = z.infer<typeof inboxUpdateSchema>
export type InboxEntry = z.infer<typeof entrySchema>
export type InboxState = z.infer<typeof stateSchema>
export type InboxView = "inbox" | "snoozed" | "deleted"
export type InboxFilter = "all" | (typeof updateKinds)[number]
export type InboxAction =
  | { type: "preferences"; changes: Partial<InboxPreferences> }
  | { type: "delete-many"; ids: Array<string> }
  | { type: "read"; ids: Array<string>; unread: boolean }
  | { type: "snooze"; id: string; until: number | null }
  | { type: "delete"; id: string; deleted: boolean }
  | { type: "subscribe"; id: string; subscribed: boolean }

const initialState: InboxState = {
  entries: [
    {
      id: "welcome",
      issue: null,
      events: [],
      unread: true,
      snoozedUntil: null,
      deleted: false,
    },
  ],
  unsubscribedIssueIds: [],
  preferences: defaultInboxPreferences,
}
const initialRaw = JSON.stringify(initialState)
const changed = "forge:inbox-changed"
export const inboxStorageKey = (scope: InboxScope) =>
  `forge:inbox:v1:${JSON.stringify([scope.workspaceId, scope.userId])}`
export const parseInbox = (raw: string): InboxState =>
  stateSchema.parse(JSON.parse(raw))
export const newInbox = (): InboxState => parseInbox(initialRaw)

/** Local adapter for the future issue activity service. Call only with events
 * already authorized for this workspace; this client store is not an auth boundary. */
export function receiveInboxUpdate(
  state: InboxState,
  scope: InboxScope,
  input: InboxUpdate
): InboxState {
  const update = inboxUpdateSchema.parse(input)
  if (
    update.workspaceId !== scope.workspaceId ||
    update.actorId === scope.userId
  )
    return state
  const direct = update.kind === "assignment" || update.kind === "mention"
  if (
    direct
      ? !update.recipientIds.includes(scope.userId)
      : !update.subscriberIds.includes(scope.userId) ||
        state.unsubscribedIssueIds.includes(update.issue.id)
  )
    return state
  const id = `issue:${update.issue.id}`
  const previous = state.entries.find((entry) => entry.id === id)
  if (previous?.events.some((event) => event.id === update.id)) return state
  const events = [...(previous?.events ?? []), eventSchema.parse(update)].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  )
  const latest = events.at(-1)?.id === update.id
  const entry: InboxEntry = {
    id,
    issue: latest ? update.issue : previous!.issue,
    events,
    unread: true,
    snoozedUntil: previous?.snoozedUntil ?? null,
    deleted: false,
  }
  return {
    ...state,
    entries: [...state.entries.filter((item) => item.id !== id), entry],
  }
}

export function reduceInbox(
  state: InboxState,
  action: InboxAction
): InboxState {
  if (action.type === "preferences") {
    return {
      ...state,
      preferences: inboxPreferencesSchema.parse({
        ...state.preferences,
        ...action.changes,
      }),
    }
  }
  if (action.type === "subscribe") {
    const issueId = state.entries.find((entry) => entry.id === action.id)?.issue
      ?.id
    if (!issueId) return state
    return {
      ...state,
      unsubscribedIssueIds: action.subscribed
        ? state.unsubscribedIssueIds.filter((id) => id !== issueId)
        : [...new Set([...state.unsubscribedIssueIds, issueId])],
    }
  }
  return {
    ...state,
    entries: state.entries.map((entry) => {
      if (action.type === "delete-many")
        return action.ids.includes(entry.id)
          ? { ...entry, deleted: true }
          : entry
      if (action.type === "read")
        return action.ids.includes(entry.id)
          ? { ...entry, unread: action.unread }
          : entry
      if (entry.id !== action.id) return entry
      return action.type === "snooze"
        ? {
            ...entry,
            snoozedUntil: action.until,
            unread: action.until !== null || entry.unread,
          }
        : { ...entry, deleted: action.deleted }
    }),
  }
}

export function visibleInboxEntries(
  state: InboxState,
  options: {
    view: InboxView
    filter: InboxFilter
    unreadOnly: boolean
    now: number
    oldestFirst?: boolean
    showSnoozed?: boolean
  }
) {
  return state.entries
    .filter((entry) => {
      const snoozed =
        entry.snoozedUntil !== null && entry.snoozedUntil > options.now
      if (
        options.view === "deleted"
          ? !entry.deleted
          : entry.deleted ||
            (options.view === "snoozed"
              ? !snoozed
              : snoozed && !options.showSnoozed)
      )
        return false
      return (
        (!options.unreadOnly || entry.unread) &&
        (options.filter === "all" ||
          entry.events.some((event) => event.kind === options.filter))
      )
    })
    .sort((a, b) => {
      const difference = (b.events.at(-1)?.createdAt ?? "").localeCompare(
        a.events.at(-1)?.createdAt ?? ""
      )
      return options.oldestFirst ? -difference : difference
    })
}

function readRaw(key: string) {
  try {
    return localStorage.getItem(key) ?? initialRaw
  } catch {
    return "unavailable"
  }
}
function writeInbox(
  scope: InboxScope,
  transform: (state: InboxState) => InboxState
) {
  const key = inboxStorageKey(scope)
  // Parse before writing: corrupt or unavailable storage is never silently replaced.
  const next = transform(parseInbox(readRaw(key)))
  localStorage.setItem(key, JSON.stringify(next))
  window.dispatchEvent(new Event(changed))
}
export function publishInboxUpdate(scope: InboxScope, update: InboxUpdate) {
  writeInbox(scope, (state) => receiveInboxUpdate(state, scope, update))
}
export function useInbox(scope: InboxScope) {
  const key = inboxStorageKey(scope)
  const raw = useSyncExternalStore(
    useCallback((notify) => {
      window.addEventListener("storage", notify)
      window.addEventListener(changed, notify)
      return () => {
        window.removeEventListener("storage", notify)
        window.removeEventListener(changed, notify)
      }
    }, []),
    () => readRaw(key),
    () => initialRaw
  )
  const result = useMemo(() => {
    try {
      return { state: parseInbox(raw), error: null }
    } catch {
      return {
        state: {
          entries: [],
          unsubscribedIssueIds: [],
          preferences: defaultInboxPreferences,
        } as InboxState,
        error:
          "Your inbox could not be loaded. Saved data has been preserved. Check that browser storage is available, then reload.",
      }
    }
  }, [raw])
  return {
    ...result,
    dispatch: (action: InboxAction) =>
      writeInbox(scope, (state) => reduceInbox(state, action)),
  }
}
