import { useSyncExternalStore } from "react"
import { initialTeamCycles } from "../../../src/lib/team-cycles-contract"

export const cycleWeekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]
export const nextCycleStart = () => new Date("2026-11-30T12:00:00")

let state = { carryover: true, rolloverAvailable: true, canManage: true }
const listeners = new Set<() => void>()
export const cycles = [
  {
    id: "closed",
    number: 12,
    start: new Date("2026-10-19T12:00:00"),
    end: new Date("2026-11-01T12:00:00"),
    timezone: "Europe/Paris",
    state: "Closed",
    issueCount: 10,
    completedCount: 6,
    closure: { closedAt: "2026-11-02T00:01:00Z", carriedCount: 4 },
  },
  {
    id: "current",
    number: 13,
    start: new Date("2026-11-02T12:00:00"),
    end: new Date("2026-11-15T12:00:00"),
    timezone: "Europe/Paris",
    state: "Current",
    issueCount: 7,
    completedCount: 1,
  },
  {
    id: "upcoming",
    number: 14,
    start: new Date("2026-11-30T12:00:00"),
    end: new Date("2026-12-13T12:00:00"),
    timezone: "Europe/Paris",
    state: "Upcoming",
    issueCount: 0,
    completedCount: 0,
  },
]
export function updateFixture(patch: Partial<typeof state>) {
  state = { ...state, ...patch }
  listeners.forEach((fn) => fn())
}
function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
export function useTeamCycles() {
  const current = useSyncExternalStore(subscribe, () => state)
  return {
    settings: {
      ...initialTeamCycles(),
      timezone: "Europe/Paris",
      enabled: true,
      carryover: current.carryover,
    },
    ready: true,
    error: null,
    pending: false,
    cycles,
    ...current,
    update: async (patch: Partial<typeof state>) => {
      updateFixture(patch)
      return true
    },
    retry: async () => true,
    discard: () => {},
  }
}
export const useCalendarWeek = () => ({ weekdays: [1, 2, 3, 4, 5, 6, 0] })
