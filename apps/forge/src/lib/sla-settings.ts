import { z } from "zod"
import { productStorage } from "@/lib/product-storage"

export const slaAutomationRuleSchema = z.object({
  id: z.string(),
  priority: z.enum(["urgent", "high", "medium", "low", "none"]),
  action: z.enum(["add", "remove"]),
  duration: z.string().optional(),
})

export const slaSettingsSchema = z.object({
  enabled: z.boolean(),
  workWeek: z.enum(["mon-fri", "mon-sat", "every-day"]),
  rules: z.array(slaAutomationRuleSchema),
})

export type SlaAutomationRule = z.infer<typeof slaAutomationRuleSchema>
export type SlaSettings = z.infer<typeof slaSettingsSchema>

export const defaultSlaRules: Array<SlaAutomationRule> = [
  {
    id: "urgent-response",
    priority: "urgent",
    action: "add",
    duration: "24 hours",
  },
  {
    id: "high-response",
    priority: "high",
    action: "add",
    duration: "1 week",
  },
  {
    id: "medium-remove",
    priority: "medium",
    action: "remove",
  },
  { id: "low-remove", priority: "low", action: "remove" },
  { id: "none-remove", priority: "none", action: "remove" },
]

export const defaultSlaSettings: SlaSettings = {
  enabled: false,
  workWeek: "mon-fri",
  rules: defaultSlaRules,
}

export function slaSettingsStorageKey(workspaceId: string) {
  return `forge:workspace:${workspaceId}:sla-settings`
}

export function readSlaSettings(workspaceId: string): SlaSettings {
  try {
    const stored = productStorage.getItem(slaSettingsStorageKey(workspaceId))
    const parsed = slaSettingsSchema
      .partial()
      .safeParse(stored ? JSON.parse(stored) : {})

    return parsed.success
      ? { ...defaultSlaSettings, ...parsed.data }
      : { ...defaultSlaSettings }
  } catch {
    return { ...defaultSlaSettings }
  }
}

export function writeSlaSettings(workspaceId: string, settings: SlaSettings) {
  productStorage.setItem(
    slaSettingsStorageKey(workspaceId),
    JSON.stringify(slaSettingsSchema.parse(settings))
  )
}
