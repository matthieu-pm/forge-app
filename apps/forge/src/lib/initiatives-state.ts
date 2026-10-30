import { useCallback, useMemo, useSyncExternalStore } from "react"
import {
  defaultInitiativePreferences,
  defaultInitiativesSettings,
  emptyInitiatives,
  initiativePreferencesKey,
  initiativeStoreSchema,
  initiativesSettingsSchema,
  initiativesSettingsStorageKey,
  initiativesStorageKey,
} from "./initiatives"
import {
  initialInitiativeLabels,
  initialProjectLabels,
  initiativeLabelsStorageKey,
  parseTeamLabels,
  projectLabelsStorageKey,
} from "./team-labels"
import type { InitiativeStore } from "./initiatives"
import { useWorkspaceView } from "@/components/account-preference-provider"

const changed = "forge:initiatives-changed"
function subscribe(notify: () => void) {
  for (const type of ["storage", "focus", changed])
    window.addEventListener(type, notify)
  return () => {
    for (const type of ["storage", "focus", changed])
      window.removeEventListener(type, notify)
  }
}
export function useInitiatives(
  workspaceId: string,
  userId: string,
  scope: "initiatives" | "projects" = "initiatives"
) {
  const sync = useWorkspaceView("initiatives", "main", { workspaceId, userId })
  const dataKey = initiativesStorageKey(workspaceId)
  const preferencesKey = initiativePreferencesKey(workspaceId, userId)
  const settingsKey = initiativesSettingsStorageKey(workspaceId)
  const raw = useSyncExternalStore(
    subscribe,
    useCallback(() => {
      try {
        return JSON.stringify(
          [
            dataKey,
            preferencesKey,
            settingsKey,
            initiativeLabelsStorageKey,
            projectLabelsStorageKey,
          ].map((key) => localStorage.getItem(key))
        )
      } catch {
        return "unavailable"
      }
    }, [dataKey, preferencesKey, settingsKey]),
    () => ""
  )
  const data = useMemo(() => {
    const result = {
      ready: Boolean(raw),
      state: emptyInitiatives(),
      preferences: defaultInitiativePreferences(),
      settings: defaultInitiativesSettings as ReturnType<
        typeof initiativesSettingsSchema.parse
      >,
      labels: initialInitiativeLabels().labels,
      projectLabels: initialProjectLabels().labels,
      error: "",
      preferencesError: "",
      settingsError: "",
      labelsError: "",
      projectLabelsError: "",
    }
    if (!raw) return result
    if (raw === "unavailable") {
      result.error =
        "Initiatives could not be loaded. Saved data has been preserved."
      return result
    }
    const values = JSON.parse(raw) as Array<string | null>
    try {
      if (values[0])
        result.state = initiativeStoreSchema.parse(JSON.parse(values[0]))
    } catch {
      result.error =
        "Saved initiatives could not be loaded. Your data has been preserved."
    }
    try {
      if (values[2])
        result.settings = initiativesSettingsSchema.parse(JSON.parse(values[2]))
    } catch {
      result.settingsError =
        "Initiative settings could not be loaded. Saved settings have been preserved."
    }
    try {
      if (values[3])
        result.labels = parseTeamLabels(values[3]).labels.filter(
          (label) => !label.archived
        )
    } catch {
      result.labelsError =
        "Initiative labels could not be loaded. Saved labels have been preserved."
    }
    try {
      if (values[4])
        result.projectLabels = parseTeamLabels(values[4]).labels.filter(
          (label) => !label.archived
        )
    } catch {
      result.projectLabelsError =
        "Project labels could not be loaded. Saved labels have been preserved."
    }
    return result
  }, [raw])
  function update(reducer: (current: InitiativeStore) => InitiativeStore) {
    if (
      !data.ready ||
      data.error ||
      (scope === "initiatives" &&
        (data.settingsError || !data.settings.enabled))
    )
      return false
    try {
      const stored = localStorage.getItem(dataKey)
      const next = initiativeStoreSchema.parse(
        reducer(
          stored
            ? initiativeStoreSchema.parse(JSON.parse(stored))
            : emptyInitiatives()
        )
      )
      localStorage.setItem(dataKey, JSON.stringify(next))
      window.dispatchEvent(new Event(changed))
      return true
    } catch {
      return false
    }
  }
  return {
    ...data,
    update,
    preferences: sync.value,
    preferencesError: sync.error,
    savePreferences: sync.save,
    writable:
      data.ready &&
      !data.error &&
      (scope === "projects" || (!data.settingsError && data.settings.enabled)),
  }
}
export type InitiativeData = ReturnType<typeof useInitiatives>
