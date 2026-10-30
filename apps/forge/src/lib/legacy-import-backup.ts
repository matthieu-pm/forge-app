import { verifyLegacyBackup } from "./legacy-import-preview"
import type { BackupRepository, LegacyBackup } from "./legacy-import-preview"

const database = "forge-legacy-backups-v1"
const store = "backups"

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1)
    let blocked = false
    request.onupgradeneeded = () => {
      const objects = request.result.createObjectStore(store, { keyPath: "id" })
      objects.createIndex("actorId", "actorId")
    }
    request.onerror = () =>
      reject(
        new Error(
          "Local backup storage is unavailable. Originals are unchanged."
        )
      )
    request.onblocked = () => {
      blocked = true
      reject(
        new Error("Close other Forge tabs and try saving the backup again.")
      )
    }
    request.onsuccess = () => {
      if (blocked) request.result.close()
      else resolve(request.result)
    }
  })
}

async function transaction<T>(
  mode: IDBTransactionMode,
  run: (objects: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode)
      const request = run(tx.objectStore(store))
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = tx.onerror = () =>
        reject(
          new Error(
            "The local backup could not be saved or read. Originals are unchanged."
          )
        )
    })
  } finally {
    db.close()
  }
}

// No TTL or automatic deletion; source localStorage is never written here.
export const browserBackupRepository: BackupRepository = {
  async put(backup: LegacyBackup) {
    await transaction("readwrite", (objects) => objects.add(backup))
  },
  get(id: string) {
    return transaction("readonly", (objects) => objects.get(id))
  },
}
export async function listBrowserBackups(
  actorId: string
): Promise<Array<LegacyBackup>> {
  const entries = await transaction<Array<unknown>>("readonly", (objects) =>
    objects.index("actorId").getAll(IDBKeyRange.only(actorId))
  )
  const verified: Array<LegacyBackup> = []
  for (const entry of entries) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      "actorId" in entry &&
      entry.actorId === actorId
    )
      verified.push(await verifyLegacyBackup(entry))
  }
  return verified.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function downloadLegacyFile(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" })
  )
  try {
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = name
    anchor.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
