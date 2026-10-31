import * as React from "react"
import { addDays, addWeeks, format } from "date-fns"
import { sharedCyclesEnabled, useSharedTeamCycles } from "./shared-cycle-client"
import { canonicalIssuesActive } from "./canonical-issue-cache"
import {
  cyclesSchema,
  initialTeamCycles,
  parseTeamCycles,
  teamCyclesStorageKey,
} from "./team-cycles-contract"
import type { TeamCyclesSettings } from "./team-cycles-contract"
import { productStorage } from "@/lib/product-storage"

export {
  teamCyclesStorageKey,
  initialTeamCycles,
  parseTeamCycles,
} from "./team-cycles-contract"
export type { TeamCyclesSettings } from "./team-cycles-contract"

const changeEvent = "forge:team-cycles-changed"

// Read the same preferences as the settings page, including changes made in
// another tab. Invalid or inaccessible preferences never enable navigation.
export function useEnabledTeamCycles(teamIds: ReadonlyArray<string>) {
  const snapshot = React.useSyncExternalStore(
    React.useCallback((notify) => {
      window.addEventListener("storage", notify)
      window.addEventListener(changeEvent, notify)
      window.addEventListener("forge:shared-cycles-changed", notify)
      return () => {
        window.removeEventListener("storage", notify)
        window.removeEventListener(changeEvent, notify)
        window.removeEventListener("forge:shared-cycles-changed", notify)
      }
    }, []),
    () =>
      JSON.stringify(
        teamIds.filter((id) => {
          try {
            const confirmed = sharedCyclesEnabled(id)
            if (confirmed !== undefined) return confirmed
            const raw = productStorage.getItem(teamCyclesStorageKey(id))
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

export function useTeamCycles(teamId: string, number?: number) {
  const shared = canonicalIssuesActive()
  const remote = useSharedTeamCycles(teamId, shared, number)
  const [settings, setSettings] = React.useState(initialTeamCycles)
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const storageKey = teamCyclesStorageKey(teamId)
  React.useEffect(() => {
    function load() {
      try {
        const raw = productStorage.getItem(storageKey)
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
      productStorage.setItem(storageKey, JSON.stringify(next))
      setSettings(next)
      window.dispatchEvent(new CustomEvent(changeEvent, { detail: storageKey }))
      return true
    } catch {
      return false
    }
  }
  if (shared)
    return {
      settings: remote.snapshot?.settings ?? initialTeamCycles(),
      ready: !!remote.snapshot || !!remote.error,
      error: remote.error,
      update: remote.update,
      pending: remote.pending,
      canManage: remote.snapshot?.canManage ?? false,
      cycles:
        remote.snapshot?.cycles.map((c) => ({
          ...c,
          start: new Date(`${c.startDate}T12:00:00`),
          end: new Date(`${c.endDate}T12:00:00`),
          value: c.id,
        })) ?? [],
      retry: remote.retry,
      discard: remote.discard,
    }
  return {
    settings,
    ready,
    error,
    update,
    pending: false,
    canManage: true,
    cycles: scheduledTeamCycles(settings).map((c) => ({
      ...c,
      id: c.value,
      startDate: c.value,
      endDate: format(c.end, "yyyy-MM-dd"),
      teamId,
      issueCount: 0,
      completedCount: 0,
      timezone: settings.timezone ?? "UTC",
      state: c.number === 1 ? "Upcoming" : "Planned",
    })),
    retry: () => Promise.resolve(false),
    discard: () => {},
  }
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

export function scheduledTeamCycles(
  settings: TeamCyclesSettings,
  now = new Date()
) {
  const first = nextCycleStart(settings.startDay, now)
  return Array.from({ length: settings.futureCycles }, (_, index) => {
    const start = addWeeks(
      first,
      index * (settings.duration + settings.cooldown)
    )
    return {
      number: index + 1,
      start,
      end: addDays(addWeeks(start, settings.duration), -1),
      value: format(start, "yyyy-MM-dd"),
    }
  })
}
