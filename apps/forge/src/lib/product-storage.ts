import { loadProductState, persistProductState } from "./product-state-server"
import type { ProductStateSnapshot } from "./product-state-contract"

let identity: Omit<ProductStateSnapshot, "entries"> | null = null
let generation = 0
const values = new Map<string, string>(),
  revisions = new Map<string, number>()
type Pending = {
  key: string
  value: string | null
  commandKey: string
  revision?: number
  recoveryCommandKey?: string
  recoveryValue?:string
}
let pending: Array<Pending> = []
let running = false
let error = ""
let definitiveFailure=false
export const PRODUCT_STORAGE_CHANGED = "forge:product-storage-changed"
function notify(key: string | null = null) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PRODUCT_STORAGE_CHANGED))
    window.dispatchEvent(new StorageEvent("storage", { key }))
  }
}
export function storageStatus() {
  return { pending: pending.length, error }
}
export function resetProductStorage() {
  generation++
  identity = null
  values.clear()
  revisions.clear()
  pending = []
  running = false
  error = ""
  definitiveFailure=false
  notify()
}
export function initializeProductStorage(snapshot: ProductStateSnapshot) {
  resetProductStorage()
  identity = snapshot
  for (const e of snapshot.entries) {
    if (e.value !== null) values.set(e.key, e.value)
    revisions.set(e.key, e.revision)
  }
  notify()
}
export function refreshProductStorage(snapshot: ProductStateSnapshot) {
  if (
    !identity ||
    snapshot.workspaceId !== identity.workspaceId ||
    snapshot.sessionId !== identity.sessionId
  )
    return
  for (const e of snapshot.entries)
    if (!pending.some((p) => p.key === e.key)) {
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
  const token = generation
  try {
    while (pending.length && token === generation) {
      const p = pending[0],
        binding = identity
      p.revision ??= revisions.get(p.key) ?? 0
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
      revisions.set(p.key, result.value.revision)
      pending.shift()
      notify(p.key)
    }
  } catch (failure) {
    definitiveFailure=failure instanceof Error && /^(\[|Only workspace admins|This data changed in another session)/.test(failure.message)
    if (token === generation)
      error =
        failure instanceof Error && !failure.message.startsWith("[")
          ? failure.message
          : "Changes could not be saved. They remain in this session."
  } finally {
    if (token === generation) {
      running = false
      notify()
    }
  }
}
// Memory-only synchronous projection for existing controls. Durability is exclusively
// authenticated server storage; the global provider displays saving/errors.
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
    values.set(key, value)
    pending.push({ key, value, commandKey: crypto.randomUUID() })
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
    values.delete(key)
    pending.push({ key, value: null, commandKey: crypto.randomUUID() })
    notify(key)
    void flushProductStorage()
  },
}
export async function saveProductValue(key: string, value: string | null) {
  if (value === null) productStorage.removeItem(key)
  else productStorage.setItem(key, value)
  await flushProductStorage()
  // A caller must never remove a migration source before its actual queued save completes.
  while (running) await new Promise((resolve) => setTimeout(resolve, 10))
  if (pending.some((p) => p.key === key) || error)
    throw new Error(error || "The server copy has not been confirmed.")
}

/** Preserve pending edits on the server before replacing a stale projection. */
export async function preservePendingAndReload() {
  if (running || !identity) return false
  running = true
  const token = generation,
    binding = identity
  try {
    for (const p of pending) {
      p.recoveryCommandKey ??= crypto.randomUUID()
      await persistProductState({
        data: {
          workspaceId: binding.workspaceId,
          sessionId: binding.sessionId,
          commandKey: p.recoveryCommandKey,
          key: `forge:pending-recovery:v1:${p.commandKey}`,
          value: p.recoveryValue??=JSON.stringify({
            key: p.key,
            value: p.value,
            expectedRevision: p.revision ?? 0,
            createdAt:new Date().toISOString(),
          }),
          expectedRevision: 0,
        },
      })
      if (token !== generation) return
    }
    const snapshot = await loadProductState()
    if (token !== generation) return
    if (
      snapshot.sessionId !== binding.sessionId ||
      snapshot.workspaceId !== binding.workspaceId
    )
      throw new Error("The active session changed.")
    for(const p of pending)if(snapshot.entries.find(entry=>entry.key===`forge:pending-recovery:v1:${p.commandKey}`)?.value!==p.recoveryValue)throw new Error("The saved recovery copy could not be verified.")
    initializeProductStorage(snapshot)
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

export function productStorageIdentity(){return identity?{workspaceId:identity.workspaceId,userId:identity.userId,sessionId:identity.sessionId,teamIds:identity.teamIds}:null}

export function productStorageFailureIsDefinitive(){return definitiveFailure}
