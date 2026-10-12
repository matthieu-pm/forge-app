import * as React from "react"
import { z } from "zod"

const cyclesSchema = z.object({
  enabled: z.boolean(),
  duration: z.number().int().min(1).max(8),
  cooldown: z.number().int().min(0).max(4),
  startDay: z.number().int().min(0).max(6),
  futureCycles: z.number().int().min(1).max(6),
  activeIssues: z.boolean(),
  startedIssues: z.boolean(),
  completedIssues: z.boolean(),
})
export type TeamCyclesSettings = z.infer<typeof cyclesSchema>
export const teamCyclesStorageKey = (teamId: string) =>
  `forge:team-cycles:v1:${teamId}`
export const initialTeamCycles = (): TeamCyclesSettings => ({
  enabled: false,
  duration: 2,
  cooldown: 2,
  startDay: 1,
  futureCycles: 2,
  activeIssues: false,
  startedIssues: true,
  completedIssues: true,
})
export const parseTeamCycles = (raw: string) =>
  cyclesSchema.parse(JSON.parse(raw))
const changeEvent = "forge:team-cycles-changed"

// Read the same preferences as the settings page, including changes made in
// another tab. Invalid or inaccessible preferences never enable navigation.
export function useEnabledTeamCycles(teamIds: ReadonlyArray<string>) {
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
            const raw = window.localStorage.getItem(teamCyclesStorageKey(id))
            return raw !== null && parseTeamCycles(raw).enabled
          } catch {
            return false
          }
        })
      ),
    () => "[]"
  )
  return React.useMemo(() => new Set<string>(JSON.parse(snapshot)), [snapshot])
}

export function useTeamCycles(teamId: string) {
  const [settings, setSettings] = React.useState(initialTeamCycles)
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const storageKey = teamCyclesStorageKey(teamId)
  React.useEffect(() => {
    function load() {
      try {
        const raw = window.localStorage.getItem(storageKey)
        setSettings(raw ? parseTeamCycles(raw) : initialTeamCycles())
        setError(null)
      } catch {
        setError(
          "Saved cycles settings could not be loaded. Your saved data has been preserved. Reload the page to try again."
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
  function update(patch: Partial<TeamCyclesSettings>) {
    if (!ready || error) return false
    try {
      const next = cyclesSchema.parse({ ...settings, ...patch })
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

export const cycleWeekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]

// The next start is strictly after today, including when today is the selected day.
export function nextCycleStart(startDay: number, now = new Date()) {
  const next = new Date(now)
  next.setHours(12, 0, 0, 0)
  next.setDate(next.getDate() + ((startDay - next.getDay() + 7) % 7 || 7))
  return next
}
