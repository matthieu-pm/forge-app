import { z } from "zod"
import { onPreferenceSessionInvalidated } from "./preference-session-events"
import { projectCommandPrefix } from "./shared-project-key"
import { loadProductState, persistProductState } from "./product-state-server"
import {
  isProductStorageKey,
  legacyStorageScope,
} from "./product-state-contract"
import type { ProductStateSnapshot } from "./product-state-contract"

let identity: Omit<ProductStateSnapshot, "entries"> | null = null
let generation = 0
let mutationEpoch = 0
export function productStorageRefreshToken() {
  return mutationEpoch
}
const values = new Map<string, string>(),
  revisions = new Map<string, number>()
type Pending = {
  key: string
  value: string | null
  commandKey: string
  revision?: number
  recoveryCommandKey?: string
  recoveryValue?: string
  createdAt?: number
}
let pending: Array<Pending> = []
let lastDraftTime = 0
let running = false
let error = ""
let definitiveFailure = false
let deviceError = ""
let restored = false
let journalWritable = true
const ownedDrafts = new Set<string>()
export const PRODUCT_STORAGE_CHANGED = "forge:product-storage-changed"
function notify(key: string | null = null) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PRODUCT_STORAGE_CHANGED))
    window.dispatchEvent(new StorageEvent("storage", { key }))
  }
}
export function storageStatus() {
  return { pending: pending.length, error, deviceError, restored }
}
export function pendingProjectDrafts() {
  return pending
    .filter((p) => p.key.startsWith(projectCommandPrefix))
    .map((p) => {
      try {
        return JSON.parse(p.value ?? "[]") as unknown
      } catch {
        return p.value
      }
    })
}
export function savedProjectDrafts() {
  return [...values].flatMap(([key, value]) => {
    if (!key.startsWith("forge:pending-recovery:v1:")) return []
    try {
      const draft = JSON.parse(value)
      return typeof draft.key === "string" &&
        draft.key.startsWith(projectCommandPrefix)
        ? [{ key, changes: JSON.parse(draft.value) as unknown }]
        : []
    } catch {
      return []
    }
  })
}
export function resetProductStorage() {
  generation++
  identity = null
  values.clear()
  revisions.clear()
  pending = []
  running = false
  error = ""
  definitiveFailure = false
  deviceError = ""
  restored = false
  journalWritable = true
  ownedDrafts.clear()
  notify()
}
export function initializeProductStorage(
  snapshot: ProductStateSnapshot,
  restore = true
) {
  resetProductStorage()
  identity = snapshot
  for (const e of snapshot.entries) {
    if (e.value !== null) values.set(e.key, e.value)
    revisions.set(e.key, e.revision)
  }
  if (restore) restoreDeviceDrafts()
  notify()
}
export function refreshProductStorage(
  snapshot: ProductStateSnapshot,
  requestToken = mutationEpoch
) {
  if (
    !identity ||
    snapshot.userId !== identity.userId ||
    snapshot.workspaceId !== identity.workspaceId ||
    snapshot.sessionId !== identity.sessionId
  )
    return
  const present = new Set(snapshot.entries.map((entry) => entry.key))
  for (const key of values.keys()) {
    const teamId = legacyStorageScope(key).teamId
    const revoked =
      teamId && snapshot.teamIds && !snapshot.teamIds.includes(teamId)
    if (
      revoked ||
      (requestToken === mutationEpoch &&
        !present.has(key) &&
        !pending.some((p) => p.key === key))
    ) {
      values.delete(key)
      if (!revoked) revisions.delete(key)
    }
  }
  identity = { ...identity, teamIds: snapshot.teamIds }
  for (const e of snapshot.entries)
    if (
      !pending.some((p) => p.key === e.key) &&
      e.revision >= (revisions.get(e.key) ?? 0)
    ) {
      if (e.value === null) values.delete(e.key)
      else values.set(e.key, e.value)
      revisions.set(e.key, e.revision)
    }
  notify()
}
export async function flushProductStorage() {
  if (running || !identity) return
  running = true
  error = ""
  definitiveFailure = false
  const token = generation
  try {
    while (pending.length && token === generation) {
      const p = pending[0],
        binding = identity
      p.revision ??= revisions.get(p.key) ?? 0
      persistDeviceDrafts()
      const result = await persistProductState({
        data: {
          workspaceId: binding.workspaceId,
          sessionId: binding.sessionId,
          key: p.key,
          value: p.value,
          commandKey: p.commandKey,
          expectedRevision: p.revision,
        },
      })
      if (token !== generation) return
      if (p.key.startsWith(projectCommandPrefix)) {
        const { refreshCanonicalIssues } =
          await import("./canonical-issue-client")
        await refreshCanonicalIssues(binding)
        if (token !== generation) return
        values.delete(p.key)
      }
      mutationEpoch++
      revisions.set(p.key, result.value.revision)
      pending.shift()
      persistDeviceDrafts()
      notify(p.key)
    }
  } catch (failure) {
    if (token === generation) {
      definitiveFailure =
        failure instanceof Error &&
        /^(\[|Only workspace admins|This data changed in another session)/.test(
          failure.message
        )
      error =
        failure instanceof Error && !failure.message.startsWith("[")
          ? failure.message
          : "Changes could not be saved. They remain in this session."
    }
  } finally {
    if (token === generation) {
      running = false
      notify()
    }
  }
}
function queueChange(key: string, value: string | null) {
  const tail = pending.at(-1)
  // Replace unsent typing with a fresh immutable record. Another tab may have
  // restored the old command, so never change the bytes behind its identity.
  if (
    tail?.key === key &&
    tail.revision === undefined &&
    !tail.recoveryCommandKey
  )
    pending.pop()
  const commandKey = crypto.randomUUID()
  lastDraftTime = Math.max(Date.now(), lastDraftTime + 1)
  ownedDrafts.add(commandKey)
  pending.push({ key, value, commandKey, createdAt: lastDraftTime })
}
// Synchronous projection for existing controls. Server confirmation and device
// recovery are separate; pending writes are always labeled unsaved.
export const productStorage = {
  get length() {
    return values.size
  },
  key(index: number) {
    return [...values.keys()][index] ?? null
  },
  clear() {
    resetProductStorage()
  },
  getItem(key: string) {
    return values.get(key) ?? null
  },
  setItem(key: string, value: string) {
    if (!identity) {
      values.set(key, value)
      notify(key)
      return
    }
    if (values.get(key) === value) return
    mutationEpoch++
    values.set(key, value)
    queueChange(key, value)
    persistDeviceDrafts()
    notify(key)
    void flushProductStorage()
  },
  removeItem(key: string) {
    if (!identity) {
      values.delete(key)
      notify(key)
      return
    }
    if (!values.has(key)) return
    mutationEpoch++
    values.delete(key)
    queueChange(key, null)
    persistDeviceDrafts()
    notify(key)
    void flushProductStorage()
  },
}
export async function saveProductValue(key: string, value: string | null) {
  const token = generation
  if (value === null) productStorage.removeItem(key)
  else productStorage.setItem(key, value)
  await flushProductStorage()
  // A caller must never remove a migration source before its actual queued save completes.
  while (running) await new Promise((resolve) => setTimeout(resolve, 10))
  if (token !== generation) throw new Error("The active session changed.")
  if (pending.some((p) => p.key === key) || error)
    throw new Error(error || "The server copy has not been confirmed.")
}

/** Preserve pending edits on the server before replacing a stale projection. */
export async function preservePendingAndReload() {
  if (running || !identity) return false
  running = true
  const token = generation,
    binding = identity
  // Freeze this batch before the first await. Typing during recovery receives
  // fresh commands and must remain pending after the snapshot is installed.
  const recovering = [...pending]
  for (const p of recovering) {
    p.recoveryCommandKey ??= crypto.randomUUID()
    p.recoveryValue ??= JSON.stringify({
      key: p.key,
      value: p.value,
      expectedRevision: p.revision ?? 0,
      createdAt: new Date().toISOString(),
    })
  }
  persistDeviceDrafts()
  try {
    for (const p of recovering) {
      await persistProductState({
        data: {
          workspaceId: binding.workspaceId,
          sessionId: binding.sessionId,
          commandKey: p.recoveryCommandKey!,
          key: `forge:pending-recovery:v1:${p.commandKey}`,
          value: p.recoveryValue!,
          expectedRevision: 0,
        },
      })
      if (token !== generation) return
    }
    const snapshot = await loadProductState()
    if (token !== generation) return
    if (recovering.some((p) => p.key.startsWith(projectCommandPrefix))) {
      const { refreshCanonicalIssues } =
        await import("./canonical-issue-client")
      await refreshCanonicalIssues(binding)
      if (token !== generation) return
    }
    if (
      snapshot.userId !== binding.userId ||
      snapshot.sessionId !== binding.sessionId ||
      snapshot.workspaceId !== binding.workspaceId
    )
      throw new Error("The active session changed.")
    for (const p of recovering)
      if (
        snapshot.entries.find(
          (entry) => entry.key === `forge:pending-recovery:v1:${p.commandKey}`
        )?.value !== p.recoveryValue
      )
        throw new Error("The saved recovery copy could not be verified.")
    const newer = pending.filter((p) => !recovering.includes(p))
    pending = newer
    persistDeviceDrafts()
    initializeProductStorage(snapshot, false)
    pending = newer
    for (const p of pending) {
      ownedDrafts.add(p.commandKey)
      if (p.value === null) values.delete(p.key)
      else values.set(p.key, p.value)
    }
    if (pending.length)
      error = "Newer unsaved changes are retained. Review and retry saving."
    persistDeviceDrafts()
    notify()
    return true
  } catch (failure) {
    if (token === generation)
      error =
        failure instanceof Error
          ? failure.message
          : "Pending edits could not be preserved. They remain in this session."
    return false
  } finally {
    if (token === generation) {
      running = false
      notify()
    }
  }
}

export function productStorageIdentity() {
  return identity
    ? {
        workspaceId: identity.workspaceId,
        userId: identity.userId,
        sessionId: identity.sessionId,
        teamIds: identity.teamIds,
      }
    : null
}

export function productStorageFailureIsDefinitive() {
  return definitiveFailure
}

// Only unconfirmed writes are journaled, never read caches. The key is selected
// after server verification; account/workspace metadata is checked again on read.
const draftJournalKey = (scope: { userId: string; workspaceId: string }) =>
  JSON.stringify(["forge.unsaved-drafts", 1, scope.userId, scope.workspaceId])
const deviceDraftSchema = z.object({
  version: z.literal(1),
  userId: z.string(),
  workspaceId: z.string(),
  pending: z.array(
    z.object({
      key: z.string().min(1).max(500).refine(isProductStorageKey),
      value: z.string().max(20_000_000).nullable(),
      commandKey: z.uuid(),
      revision: z.number().int().nonnegative().optional(),
      recoveryCommandKey: z.uuid().optional(),
      recoveryValue: z.string().optional(),
      createdAt: z.number().finite().optional(),
    })
  ),
})
const draftRecordPrefix = (scope: { userId: string; workspaceId: string }) =>
  JSON.stringify([
    "forge.unsaved-draft",
    1,
    scope.userId,
    scope.workspaceId,
  ]).slice(0, -1) + ","
const draftRecordKey = (
  scope: { userId: string; workspaceId: string },
  commandKey: string
) => draftRecordPrefix(scope) + JSON.stringify(commandKey) + "]"
function parseDeviceDrafts(raw: string) {
  const journal = deviceDraftSchema.parse(JSON.parse(raw))
  if (
    journal.userId !== identity?.userId ||
    journal.workspaceId !== identity.workspaceId
  )
    throw new Error()
  return journal.pending
}
function legacyDeviceDrafts() {
  if (!identity) return []
  const raw = localStorage.getItem(draftJournalKey(identity))
  return raw
    ? parseDeviceDrafts(raw).map((p, index) => ({
        ...p,
        createdAt: p.createdAt ?? index + 1,
      }))
    : []
}
function readDeviceDrafts() {
  if (!identity) return []
  const records = new Map(legacyDeviceDrafts().map((p) => [p.commandKey, p]))
  const keys = Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index)
  )
  for (const key of keys) {
    if (!key?.startsWith(draftRecordPrefix(identity))) continue
    const parts = JSON.parse(key)
    const commandKey = z.uuid().parse(parts[4])
    const raw = localStorage.getItem(key)
    if (!raw) continue
    if (raw === "null") {
      records.delete(commandKey)
      continue
    }
    const entries = parseDeviceDrafts(raw)
    if (entries.length !== 1 || entries[0].commandKey !== commandKey)
      throw new Error()
    records.set(commandKey, {
      ...entries[0],
      createdAt: entries[0].createdAt ?? 0,
    })
  }
  return [...records.values()].sort((a, b) => a.createdAt - b.createdAt)
}
function persistDeviceDrafts() {
  if (!identity || typeof window === "undefined") return
  try {
    if (!journalWritable) throw new Error()
    const legacy = new Set(legacyDeviceDrafts().map((p) => p.commandKey))
    const retained = new Set(pending.map((p) => p.commandKey))
    // Separate command keys avoid a cross-tab read/modify/write race. Write new
    // records before retiring superseded typing; quota failures preserve old data.
    for (const p of pending)
      localStorage.setItem(
        draftRecordKey(identity, p.commandKey),
        JSON.stringify({
          version: 1,
          userId: identity.userId,
          workspaceId: identity.workspaceId,
          pending: [p],
        })
      )
    for (const id of ownedDrafts)
      if (!retained.has(id)) {
        if (legacy.has(id))
          localStorage.setItem(draftRecordKey(identity, id), "null")
        else localStorage.removeItem(draftRecordKey(identity, id))
        ownedDrafts.delete(id)
      }
    deviceError = ""
  } catch {
    deviceError =
      "Unsaved changes are only in this tab. Device storage is unavailable; keep this tab open."
  }
}
function restoreDeviceDrafts() {
  if (!identity || typeof window === "undefined") return
  try {
    const recovered = readDeviceDrafts()
    // Membership is live. Retain inaccessible drafts on disk without exposing them.
    pending = recovered.filter((item) => {
      const hint = legacyStorageScope(item.key)
      return (
        (!hint.userId || hint.userId === identity!.userId) &&
        (!hint.workspaceId || hint.workspaceId === identity!.workspaceId) &&
        (!hint.teamId ||
          !identity!.teamIds ||
          identity!.teamIds.includes(hint.teamId))
      )
    })
    for (const item of pending) {
      lastDraftTime = Math.max(lastDraftTime, item.createdAt ?? 0)
      ownedDrafts.add(item.commandKey)
      // Preserve the original baseline and retry identity through reloads.
      if (item.value === null) values.delete(item.key)
      else values.set(item.key, item.value)
    }
    restored = pending.length > 0
    if (restored)
      error =
        "Unsaved drafts recovered from this device. Review and retry saving when connected."
  } catch {
    journalWritable = false
    deviceError =
      "Device drafts could not be read. The original copy is preserved."
  }
}
if (typeof window !== "undefined")
  onPreferenceSessionInvalidated(() => resetProductStorage())
