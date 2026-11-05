import type {
  SavedRecurringIssue,
  saveRecurringIssueSchema,
} from "@/lib/recurring-issue-contract"
import type { z } from "zod"
import { nextRecurrenceIndex, occurrenceAt } from "@/lib/recurrence-calendar"

const records = new Map<string, SavedRecurringIssue>()
export async function saveRecurringIssue({
  data,
}: {
  data: z.infer<typeof saveRecurringIssueSchema> & {
    workspaceId: string
    sessionId: string
  }
}) {
  const saved = records.get(data.commandKey) ?? {
    id: data.id ?? crypto.randomUUID(),
    payload: data.payload,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: data.enabled ? ("active" as const) : ("disabled" as const),
    ownerId: "fixture-owner",
    nextAt: occurrenceAt(
      data.payload,
      nextRecurrenceIndex(data.payload, new Date())
    ).toISOString(),
    skippedCount: 0,
    recentEvents: [],
  }
  records.set(data.commandKey, saved)
  setTimeout(
    () =>
      window.dispatchEvent(
        new CustomEvent("for68-fixture-saved", { detail: saved })
      ),
    0
  )
  return { ok: true as const, id: saved.id }
}
export async function deleteRecurringIssue({ data }: { data: { id: string } }) {
  for (const [key, record] of records)
    if (record.id === data.id) records.delete(key)
  return { ok: true }
}
export async function loadRecurringIssues() {
  return [...records.values()]
}
