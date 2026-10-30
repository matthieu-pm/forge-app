import { isProductStorageKey } from "./product-state-contract"
import {
  preservePendingAndReload,
  productStorage,
  saveProductValue,
} from "./product-storage"

// The only access to persistent browser data: read legacy sources, copy to an
// authenticated server record, then remove exactly the bytes we verified.
export async function migrateBrowserData() {
  const failures: Array<string> = []
  for (const storage of [window.localStorage, window.sessionStorage]) {
    const keys = Array.from({ length: storage.length }, (_, i) =>
      storage.key(i)
    ).filter((k): k is string => Boolean(k && isProductStorageKey(k)))
    for (const key of keys) {
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
        if (await preservePendingAndReload()) {
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
  return failures
}
