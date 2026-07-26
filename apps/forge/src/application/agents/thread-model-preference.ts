import { z } from "zod"

import type { ModelReasoningEffort } from "@/application/agents/model-contract"

export const threadModelPreferenceInputSchema = z
  .object({
    mode: z.enum(["auto", "manual"]),
    selectedConnectionId: z.string().uuid().nullable(),
    selectedModelId: z.string().trim().min(1).max(255).nullable(),
    selectedEffort: z
      .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasModel = value.selectedModelId !== null
    const hasManualSelection = value.selectedConnectionId !== null && hasModel
    if (value.mode === "auto" && hasModel) {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message:
          "Auto preferences can prefer a connection but cannot pin a model.",
      })
    }
    if (value.mode === "manual" && !hasManualSelection) {
      context.addIssue({
        code: "custom",
        path: ["mode"],
        message: "Manual preferences require a connection and model.",
      })
    }
  })

export type ThreadModelPreferenceInput = z.infer<
  typeof threadModelPreferenceInputSchema
>

export type ThreadModelPreferenceRecord = {
  threadId: string
  mode: "auto" | "manual"
  selectedConnectionId: string | null
  selectedModelId: string | null
  selectedEffort: ModelReasoningEffort | null
  updatedAt: Date
}

export interface ThreadModelPreferenceStore {
  get: (threadId: string) => Promise<ThreadModelPreferenceRecord | null>
  upsert: (
    input: ThreadModelPreferenceRecord
  ) => Promise<ThreadModelPreferenceRecord>
}
