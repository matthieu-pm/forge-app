import { z } from "zod"

export const issueCopyPrefixes = [
  "forge:inbox:v1:",
  "forge:team-issue-edit-drafts:v1:",
  "forge:team-relationship-draft:v1:",
  "forge:pending-recovery:v1:",
  "forge:legacy-conflict:v1:",
]
export const isIssueCopyKey = (key: string) =>
  issueCopyPrefixes.some((prefix) => key.startsWith(prefix))
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid saved issue copy.")
  return value as Record<string, unknown>
}
const id = (value: unknown) =>
  typeof value === "string" && z.uuid().safeParse(value).success
    ? value.toLowerCase()
    : null

/** Only protocol-defined references are inspected, never arbitrary rich text or
 * legacy import sources. Returning null removes an exhausted copy, not its key. */
export function filterIssueCopy(
  key: string,
  value: string | null,
  keep: (id: string) => boolean,
  depth = 0,
  mode: "read" | "scrub" = "scrub"
): string | null {
  if (value === null || !isIssueCopyKey(key)) return value
  if (depth > 8) throw new Error("Saved recovery nesting exceeds its limit.")
  const data = object(JSON.parse(value))
  if (
    key.startsWith("forge:pending-recovery:v1:") ||
    key.startsWith("forge:legacy-conflict:v1:")
  ) {
    if (
      typeof data.key !== "string" ||
      (data.value !== null && typeof data.value !== "string")
    )
      throw new Error("Invalid recovery copy.")
    const nested = filterIssueCopy(data.key, data.value, keep, depth + 1, mode)
    return nested === null ? null : JSON.stringify({ ...data, value: nested })
  }
  if (key.startsWith("forge:team-relationship-draft:v1:")) {
    const input = object(data.input)
    const ids = [id(input.issueId), id(input.targetId)]
    if (ids.some((value) => !value))
      throw new Error("Invalid relationship copy.")
    return ids.every((value) => keep(value!)) ? value : null
  }
  const field = key.startsWith("forge:inbox:v1:") ? "entries" : "edits"
  if (!Array.isArray(data[field])) throw new Error("Invalid saved issue copy.")
  const entries = (data[field] as Array<unknown>).filter((entry) => {
    const row = object(entry)
    const target =
      field === "entries"
        ? row.issue
          ? id(object(row.issue).id)
          : null
        : id(row.issueId)
    if (field === "edits" && !target) throw new Error("Invalid edit copy.")
    return !target || keep(target)
  })
  if (field === "edits" && entries.length !== data[field].length) {
    if (mode === "read" || !entries.length) return null
    // Scrubbing changes an exact command payload. It becomes an inert recovery
    // proposal; the client must review latest state and mint a new command key.
    return JSON.stringify({ ...data, [field]: entries, requiresReview: true })
  }
  return JSON.stringify({ ...data, [field]: entries })
}
export function issueCopyIds(key: string, value: string | null) {
  const ids = new Set<string>()
  filterIssueCopy(key, value, (issueId) => {
    ids.add(issueId)
    return true
  })
  if (ids.size > 5000)
    throw new Error("Saved issue copy exceeds its supported limit.")
  return [...ids]
}

/** Retain unavailable, still-recoverable entries when a filtered projection is
 * saved. Explicit null is the user's discard; purge never uses this merge. */
export function retainHiddenIssueCopies(
  key: string,
  incoming: string | null,
  previous: string | null,
  retained: Set<string>,
  depth = 0
): string | null {
  if (!previous || !isIssueCopyKey(key) || !retained.size) return incoming
  if (depth > 8) throw new Error("Saved recovery nesting exceeds its limit.")
  const old = object(JSON.parse(previous)),
    next = incoming ? object(JSON.parse(incoming)) : null
  if (
    key.startsWith("forge:pending-recovery:v1:") ||
    key.startsWith("forge:legacy-conflict:v1:")
  ) {
    if (
      typeof old.key !== "string" ||
      (old.value !== null && typeof old.value !== "string")
    )
      return incoming
    if (next && next.key !== old.key)
      throw new Error(
        "Restore or discard the unavailable recovery copy before replacing it."
      )
    const nested = retainHiddenIssueCopies(
      old.key,
      (next?.value ?? null) as string | null,
      old.value,
      retained,
      depth + 1
    )
    return nested === null
      ? incoming
      : JSON.stringify({ ...old, ...next, value: nested })
  }
  if (key.startsWith("forge:team-relationship-draft:v1:"))
    return issueCopyIds(key, previous).some((issueId) => retained.has(issueId))
      ? previous
      : incoming
  const field = key.startsWith("forge:inbox:v1:") ? "entries" : "edits"
  if (!Array.isArray(old[field])) return incoming
  const hidden = (old[field] as Array<unknown>).filter((entry) => {
    const row = object(entry),
      target =
        field === "entries"
          ? row.issue
            ? id(object(row.issue).id)
            : null
          : id(row.issueId)
    return target && retained.has(target)
  })
  if (!hidden.length) return incoming
  const visible = Array.isArray(next?.[field])
    ? (next[field] as Array<unknown>)
    : []
  return JSON.stringify({ ...old, ...next, [field]: [...visible, ...hidden] })
}

export function hasRetainedCommandCopy(
  key: string,
  value: string | null,
  retained: Set<string>,
  depth = 0
): boolean {
  if (!value || !isIssueCopyKey(key)) return false
  if (depth > 8) throw new Error("Saved recovery nesting exceeds its limit.")
  if (key.startsWith("forge:team-issue-edit-drafts:v1:"))
    return issueCopyIds(key, value).some((id) => retained.has(id))
  if (
    key.startsWith("forge:pending-recovery:v1:") ||
    key.startsWith("forge:legacy-conflict:v1:")
  ) {
    const data = object(JSON.parse(value))
    return (
      typeof data.key === "string" &&
      (data.value === null || typeof data.value === "string") &&
      hasRetainedCommandCopy(
        data.key,
        data.value,
        retained,
        depth + 1
      )
    )
  }
  return false
}
