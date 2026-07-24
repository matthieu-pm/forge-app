import "@tanstack/react-start/server-only"

import { eq } from "drizzle-orm"

import type {
  ThreadModelPreferenceRecord,
  ThreadModelPreferenceStore,
} from "@/application/agents/thread-model-preference"
import type { ModelReasoningEffort } from "@/application/agents/model-contract"
import { db, threadModelPreferences } from "@/db"

function toRecord(
  preference: typeof threadModelPreferences.$inferSelect
): ThreadModelPreferenceRecord {
  return {
    ...preference,
    mode: preference.mode as ThreadModelPreferenceRecord["mode"],
    selectedEffort:
      preference.selectedEffort as ModelReasoningEffort | null,
  }
}

export class DrizzleThreadModelPreferenceStore
  implements ThreadModelPreferenceStore
{
  async get(threadId: string) {
    const rows = await db
      .select()
      .from(threadModelPreferences)
      .where(eq(threadModelPreferences.threadId, threadId))
      .limit(1)
    const preference = rows.at(0)
    return preference ? toRecord(preference) : null
  }

  async upsert(input: ThreadModelPreferenceRecord) {
    const rows = await db
      .insert(threadModelPreferences)
      .values(input)
      .onConflictDoUpdate({
        target: threadModelPreferences.threadId,
        set: {
          mode: input.mode,
          selectedConnectionId: input.selectedConnectionId,
          selectedModelId: input.selectedModelId,
          selectedEffort: input.selectedEffort,
          updatedAt: input.updatedAt,
        },
      })
      .returning()
    const preference = rows.at(0)
    if (!preference) {
      throw new Error("The thread model preference could not be saved.")
    }
    return toRecord(preference)
  }
}

