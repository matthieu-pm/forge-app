import { useCallback, useMemo, useSyncExternalStore } from "react"
import { z } from "zod"
import {
  defaultIssueDisplay,
  displaySchema,
  emptyIssueFilters,
  filtersSchema,
} from "./team-issues"

export const cycleIssueViewKey = (teamId: string, cycle: string) =>
  `forge:cycle-issue-view:v1:${teamId}:${cycle}`
const schema = z.object({
  display: displaySchema,
  defaultDisplay: displaySchema,
  filters: filtersSchema,
  favorite: z.boolean(),
})
type CycleIssueView = z.infer<typeof schema>
const initial = (): CycleIssueView => ({
  display: defaultIssueDisplay(),
  defaultDisplay: defaultIssueDisplay(),
  filters: emptyIssueFilters(),
  favorite: false,
})
const changed = "forge:cycle-issue-view-changed"
function subscribe(notify: () => void) {
  for (const event of ["storage", "focus", changed])
    window.addEventListener(event, notify)
  return () => {
    for (const event of ["storage", "focus", changed])
      window.removeEventListener(event, notify)
  }
}
export function useCycleIssueView(teamId: string, cycle: string) {
  const key = cycleIssueViewKey(teamId, cycle)
  const raw = useSyncExternalStore(
    subscribe,
    useCallback(() => {
      try {
        return localStorage.getItem(key) ?? ""
      } catch {
        return "unavailable"
      }
    }, [key]),
    () => ""
  )
  const result = useMemo(() => {
    try {
      return {
        value: raw ? schema.parse(JSON.parse(raw)) : initial(),
        error: "",
      }
    } catch {
      return {
        value: initial(),
        error:
          "Cycle display options could not be loaded. Saved preferences have been preserved.",
      }
    }
  }, [raw])
  function save(patch: Partial<CycleIssueView>) {
    if (result.error) return false
    try {
      const current = localStorage.getItem(key)
      const next = schema.parse({
        ...(current ? schema.parse(JSON.parse(current)) : initial()),
        ...patch,
      })
      localStorage.setItem(key, JSON.stringify(next))
      window.dispatchEvent(new Event(changed))
      return true
    } catch {
      return false
    }
  }
  return { ...result, save }
}
