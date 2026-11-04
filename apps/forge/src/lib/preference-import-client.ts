import {
  preferenceSourceFingerprint,
  preferenceSourceGroup,
} from "./preference-import-contract"
import type { PreferenceImportSource } from "./preference-import-contract"
import type { StorageReader } from "./legacy-import-preview"

export function discoverPreferenceSources(
  stores: Array<{
    location: PreferenceImportSource["location"]
    storage: StorageReader
  }>,
  userId: string
) {
  const sources: Array<PreferenceImportSource> = []
  let excludedAccounts = 0
  for (const { location, storage } of stores) {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index)
      if (!key) continue
      if (location === "saved" && key.startsWith("forge:legacy-conflict:v1:")) {
        const raw = storage.getItem(key)
        if (raw !== null) {
          try {
            const copy = JSON.parse(raw)
            if (
              typeof copy.key === "string" &&
              preferenceSourceGroup(copy.key, userId) &&
              typeof copy.value === "string"
            )
              sources.push({
                location,
                key: copy.key,
                raw: copy.value,
                recovery: { key, raw },
              })
          } catch {
            /* Other recovery formats belong to their original import tools. */
          }
        }
        continue
      }
      if (!preferenceSourceGroup(key, userId)) {
        if (/^forge:(calls-and-transcripts|notifications):v\d+:/.test(key))
          excludedAccounts++
        continue
      }
      const raw = storage.getItem(key)
      if (raw !== null) sources.push({ location, key, raw })
    }
  }
  return { sources, excludedAccounts }
}
export async function assertPreferenceSourceUnchanged(
  source: PreferenceImportSource,
  storage: StorageReader,
  fingerprint: string
) {
  const raw = storage.getItem(source.recovery?.key ?? source.key)
  if (
    raw === null ||
    (await preferenceSourceFingerprint(
      source.recovery
        ? { ...source, recovery: { ...source.recovery, raw } }
        : { ...source, raw }
    )) !== fingerprint
  )
    throw new Error(
      "The source changed. Its original copy is preserved. Preview again before continuing."
    )
}
