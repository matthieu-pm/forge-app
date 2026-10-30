import {
  isLegacyProductStorageKey,
  legacyStorageScope,
} from "./product-state-contract"
import {
  preservePendingAndReload,
  productStorage,
  productStorageFailureIsDefinitive,
  productStorageIdentity,
  saveProductValue,
} from "./product-storage"

// The only access to persistent browser data: read legacy sources, copy to an
// authenticated server record, then remove exactly the bytes we verified.
export async function migrateBrowserData() {
  const failures: Array<string> = []
  for (const storage of [window.localStorage, window.sessionStorage]) {
    const keys = Array.from({ length: storage.length }, (_, i) =>
      storage.key(i)
    ).filter((k): k is string => Boolean(k && isLegacyProductStorageKey(k)))
    for (const key of keys) {
      const identity = productStorageIdentity(),
        hint = legacyStorageScope(key)
      if (!identity) return failures
      if (
        (hint.userId &&
          hint.userId !== identity.userId &&
          hint.userId !== "You") ||
        (hint.workspaceId && hint.workspaceId !== identity.workspaceId) ||
        (hint.teamId &&
          identity.teamIds &&
          !identity.teamIds.includes(hint.teamId))
      )
        continue
      const raw = storage.getItem(key)
      if (raw === null) continue
      try {
        const existing = productStorage.getItem(key)
        if (existing !== null && existing !== raw) {
          await saveProductValue(
            `forge:legacy-conflict:v1:${crypto.randomUUID()}`,
            JSON.stringify({
              key,
              value: raw,
              reason: "Different server value",
              importedAt: new Date().toISOString(),
            })
          )
        } else await saveProductValue(key, raw)
        if (storage.getItem(key) === raw) storage.removeItem(key)
      } catch {
        if (
          productStorageFailureIsDefinitive() &&
          (await preservePendingAndReload())
        ) {
          if (storage.getItem(key) === raw) storage.removeItem(key)
          failures.push(
            "A saved source could not be applied. Its original content has been preserved privately on the server for review."
          )
          continue
        }
        failures.push(
          `${key}: its browser copy could not yet be migrated. No new browser data will be written.`
        )
      }
    }
  }
  try {
    failures.push(...(await migrateExistingDeviceBackups()))
  } catch {
    failures.push(
      "Existing device backups could not yet be migrated. Their originals are preserved."
    )
  }
  const sidebar = document.cookie
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith("sidebar_state="))
  if (sidebar)
    try {
      await saveProductValue(
        "forge:sidebar-open:v1",
        sidebar.slice("sidebar_state=".length)
      )
      document.cookie = "sidebar_state=; path=/; max-age=0"
    } catch {
      failures.push(
        "The previous sidebar preference could not be migrated yet."
      )
    }
  return failures
}

async function migrateExistingDeviceBackups(): Promise<Array<string>> {
  const identity = productStorageIdentity()
  if (
    !identity ||
    typeof indexedDB === "undefined" ||
    typeof indexedDB.databases !== "function"
  )
    return []
  const databases = await indexedDB.databases()
  if (
    !databases.some((database) => database.name === "forge-legacy-backups-v1")
  )
    return []
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("forge-legacy-backups-v1")
    // Never create a database if another tab removed it after enumeration.
    request.onupgradeneeded = () => request.transaction?.abort()
    request.onerror = () =>
      reject(new Error("Existing device backups could not be read."))
    request.onsuccess = () => resolve(request.result)
  })
  const failures: Array<string> = []
  try {
    const entries = await new Promise<Array<unknown>>((resolve, reject) => {
      const transaction = db.transaction("backups", "readonly"),
        store = transaction.objectStore("backups")
      const request = store
        .index("actorId")
        .getAll(IDBKeyRange.only(identity.userId))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () =>
        reject(new Error("Existing device backups could not be read."))
    })
    const [{ verifyLegacyBackup }, { browserBackupRepository }] =
      await Promise.all([
        import("./legacy-import-preview"),
        import("./legacy-import-backup"),
      ])
    for (const entry of entries) {
      try {
        const backup = await verifyLegacyBackup(entry)
        if (backup.actorId !== identity.userId) continue
        await browserBackupRepository.put(backup)
        const verified = await verifyLegacyBackup(
          await browserBackupRepository.get(backup.id)
        )
        if (!verified || verified.checksum !== backup.checksum)
          throw new Error("The server backup did not match.")
        const current = productStorageIdentity()
        if (
          current?.sessionId !== identity.sessionId ||
          current.workspaceId !== identity.workspaceId
        )
          return failures
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction("backups", "readwrite"),
            store = transaction.objectStore("backups"),
            request = store.get(backup.id)
          request.onsuccess = () => {
            if (JSON.stringify(request.result) === JSON.stringify(entry))
              store.delete(backup.id)
          }
          transaction.oncomplete = () => resolve()
          transaction.onerror = transaction.onabort = () =>
            reject(new Error("Device backup cleanup could not be confirmed."))
        })
      } catch {
        failures.push(
          "An existing device backup could not be migrated safely. Its original copy is preserved; new backups are saved on the server."
        )
      }
    }
  } finally {
    db.close()
  }
  return failures
}
