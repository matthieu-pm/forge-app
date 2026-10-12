import { useCallback, useMemo, useSyncExternalStore } from "react"
import { z } from "zod"

const issueSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  cycle: z.string().min(1),
  title: z.string().trim().min(1).max(240),
  description: z.string().max(10000),
  status: z.string().min(1),
  priority: z.enum(["No priority", "Urgent", "High", "Medium", "Low"]),
  createdAt: z.string().datetime(),
})
export type CycleIssue = z.infer<typeof issueSchema>
export type CycleIssueDraft = Pick<
  CycleIssue,
  "title" | "description" | "status" | "priority"
>
export const cycleIssuesKey = (teamId: string) =>
  `forge:cycle-issues:v1:${teamId}`
export const parseCycleIssues = (raw: string) =>
  z.array(issueSchema).parse(JSON.parse(raw))
const eventName = "forge:cycle-issues-changed"

export function useCycleIssues(teamId: string, cycle: string) {
  const key = cycleIssuesKey(teamId)
  const raw = useSyncExternalStore(
    useCallback((notify) => {
      window.addEventListener("storage", notify)
      window.addEventListener(eventName, notify)
      return () => {
        window.removeEventListener("storage", notify)
        window.removeEventListener(eventName, notify)
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
  const { issues, error } = useMemo(() => {
    try {
      return { issues: parseCycleIssues(raw), error: null }
    } catch {
      return {
        issues: [],
        error:
          "Saved cycle issues could not be loaded. Your saved data has been preserved.",
      }
    }
  }, [raw])

  function save(draft: CycleIssueDraft, id?: string) {
    if (error) throw new Error(error)
    // Re-read before writing so another window's latest issues are preserved.
    const current = parseCycleIssues(localStorage.getItem(key) ?? "[]")
    const previous = id
      ? current.find((issue) => issue.id === id && issue.cycle === cycle)
      : undefined
    if (id && !previous)
      throw new Error(
        "This issue is no longer available. Reload and try again."
      )
    const issue = issueSchema.parse({
      ...previous,
      ...draft,
      id: previous?.id ?? crypto.randomUUID(),
      number:
        previous?.number ??
        Math.max(0, ...current.map((item) => item.number)) + 1,
      cycle,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
    })
    localStorage.setItem(
      key,
      JSON.stringify(
        previous
          ? current.map((item) => (item.id === id ? issue : item))
          : [...current, issue]
      )
    )
    window.dispatchEvent(new Event(eventName))
    return issue
  }
  return {
    issues: issues.filter((issue) => issue.cycle === cycle),
    error,
    save,
  }
}
