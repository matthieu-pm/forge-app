import { useCallback, useMemo, useSyncExternalStore } from "react"
import { z } from "zod"

export const triagePriorities = [
  "No priority",
  "Urgent",
  "High",
  "Medium",
  "Low",
] as const
const schema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().trim().min(1).max(240),
  description: z.string().max(10000),
  priority: z.enum(triagePriorities),
  dueDate: z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/),
  snoozed: z.boolean(),
  createdAt: z.string().datetime(),
})
export type TriageIssue = z.infer<typeof schema>
export type TriageDraft = Pick<
  TriageIssue,
  "title" | "description" | "priority" | "dueDate"
>
export const triageIssuesKey = (teamId: string) =>
  `forge:triage-issues:v1:${teamId}`
export const parseTriageIssues = (raw: string) =>
  z.array(schema).parse(JSON.parse(raw))
const changed = "forge:triage-issues-changed"

export function useTriageIssues(teamId: string) {
  const key = triageIssuesKey(teamId)
  const raw = useSyncExternalStore(
    useCallback((notify) => {
      window.addEventListener("storage", notify)
      window.addEventListener(changed, notify)
      return () => {
        window.removeEventListener("storage", notify)
        window.removeEventListener(changed, notify)
      }
    }, []),
    () => {
      try {
        return localStorage.getItem(key) ?? "[]"
      } catch {
        return "unavailable"
      }
    },
    () => "[]"
  )
  const state = useMemo(() => {
    try {
      return { issues: parseTriageIssues(raw), error: null }
    } catch {
      return {
        issues: [],
        error:
          "Saved triage issues could not be loaded. Your saved data has been preserved.",
      }
    }
  }, [raw])
  function save(draft: TriageDraft, id?: string, snoozed?: boolean) {
    if (state.error) throw new Error(state.error)
    const current = parseTriageIssues(localStorage.getItem(key) ?? "[]")
    const previous = current.find((issue) => issue.id === id)
    if (id && !previous) throw new Error("This issue is no longer available.")
    const issue = schema.parse({
      ...draft,
      id: previous?.id ?? crypto.randomUUID(),
      number:
        previous?.number ??
        Math.max(0, ...current.map((item) => item.number)) + 1,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
      snoozed: snoozed ?? previous?.snoozed ?? false,
    })
    localStorage.setItem(
      key,
      JSON.stringify(
        previous
          ? current.map((item) => (item.id === id ? issue : item))
          : [...current, issue]
      )
    )
    window.dispatchEvent(new Event(changed))
    return issue
  }
  return { ...state, save }
}
