import * as React from "react"
import { z } from "zod"

const triageSchema = z.object({
  enabled: z.boolean(),
  requirePriority: z.boolean(),
})
export type TeamTriageSettings = z.infer<typeof triageSchema>
export const teamTriageStorageKey = (teamId: string) =>
  `forge:team-triage:v1:${teamId}`
export const initialTeamTriage = (): TeamTriageSettings => ({
  enabled: false,
  requirePriority: false,
})
export const parseTeamTriage = (raw: string) =>
  triageSchema.parse(JSON.parse(raw))
const changeEvent = "forge:team-triage-changed"

export function useTeamTriage(teamId: string) {
  const [settings, setSettings] = React.useState(initialTeamTriage)
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const storageKey = teamTriageStorageKey(teamId)
  React.useEffect(() => {
    function load() {
      try {
        const raw = window.localStorage.getItem(storageKey)
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
      const next = { ...settings, ...patch }
      window.localStorage.setItem(storageKey, JSON.stringify(next))
      setSettings(next)
      window.dispatchEvent(new CustomEvent(changeEvent, { detail: storageKey }))
      return true
    } catch {
      return false
    }
  }
  return { settings, ready, error, update }
}
