import * as React from "react"
import {
  initialTeamTriage,
  parseTeamTriage,
  teamTriageStorageKey,
  triageSchema,
} from "./team-triage-contract"
import type { TeamTriageSettings } from "./team-triage-contract"
import { productStorage } from "@/lib/product-storage"

export {
  teamTriageStorageKey,
  initialTeamTriage,
  parseTeamTriage,
} from "./team-triage-contract"
export type { TeamTriageSettings } from "./team-triage-contract"

const changeEvent = "forge:team-triage-changed"

export function useEnabledTeamTriage(teamIds: ReadonlyArray<string>) {
  const snapshot = React.useSyncExternalStore(
    React.useCallback((notify) => {
      window.addEventListener("storage", notify)
      window.addEventListener(changeEvent, notify)
      return () => {
        window.removeEventListener("storage", notify)
        window.removeEventListener(changeEvent, notify)
      }
    }, []),
    () =>
      JSON.stringify(
        teamIds.filter((id) => {
          try {
            const raw = productStorage.getItem(teamTriageStorageKey(id))
            return raw !== null && parseTeamTriage(raw).enabled
          } catch {
            return false
          }
        })
      ),
    () => "[]"
  )
  return React.useMemo(() => new Set<string>(JSON.parse(snapshot)), [snapshot])
}

export function useTeamTriage(teamId: string) {
  const [settings, setSettings] = React.useState(initialTeamTriage)
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const storageKey = teamTriageStorageKey(teamId)
  React.useEffect(() => {
    function load() {
      try {
        const raw = productStorage.getItem(storageKey)
        setSettings(raw ? parseTeamTriage(raw) : initialTeamTriage())
        setError(null)
      } catch {
        setError(
          "Saved triage settings could not be loaded. Your saved data has been preserved. Reload the page to try again."
        )
      }
      setReady(true)
    }
    function onStorage(event: StorageEvent) {
      if (event.key === storageKey || event.key === null) load()
    }
    function onChange(event: Event) {
      if ((event as CustomEvent<string>).detail === storageKey) load()
    }
    load()
    window.addEventListener("storage", onStorage)
    window.addEventListener(changeEvent, onChange)
    return () => {
      window.removeEventListener("storage", onStorage)
      window.removeEventListener(changeEvent, onChange)
    }
  }, [storageKey])
  function update(patch: Partial<TeamTriageSettings>) {
    if (!ready || error) return false
    try {
      const latest = productStorage.getItem(storageKey)
      const next = triageSchema.parse({
        ...(latest ? parseTeamTriage(latest) : settings),
        ...patch,
      })
      productStorage.setItem(storageKey, JSON.stringify(next))
      setSettings(next)
      window.dispatchEvent(new CustomEvent(changeEvent, { detail: storageKey }))
      return true
    } catch {
      return false
    }
  }
  return { settings, ready, error, update }
}
