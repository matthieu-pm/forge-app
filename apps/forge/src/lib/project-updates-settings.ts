import { z } from "zod"
import { productStorage } from "@/lib/product-storage"

export const projectUpdateScheduleSchema = z.enum([
  "none",
  "1-week",
  "2-weeks",
  "3-weeks",
  "4-weeks",
  "5-weeks",
  "6-weeks",
  "7-weeks",
  "8-weeks",
])

export const projectUpdatesSettingsSchema = z.object({
  schedule: projectUpdateScheduleSchema,
})

export type ProjectUpdateSchedule = z.infer<typeof projectUpdateScheduleSchema>
export type ProjectUpdatesSettings = z.infer<
  typeof projectUpdatesSettingsSchema
>

export const defaultProjectUpdatesSettings: ProjectUpdatesSettings = {
  schedule: "none",
}

export function projectUpdatesSettingsStorageKey(workspaceId: string) {
  return `forge:workspace:${workspaceId}:project-updates-settings`
}

export function readProjectUpdatesSettings(
  workspaceId: string
): ProjectUpdatesSettings {
  try {
    const stored = productStorage.getItem(
      projectUpdatesSettingsStorageKey(workspaceId)
    )
    return stored
      ? projectUpdatesSettingsSchema.parse(JSON.parse(stored))
      : { ...defaultProjectUpdatesSettings }
  } catch {
    return { ...defaultProjectUpdatesSettings }
  }
}

export function writeProjectUpdatesSettings(
  workspaceId: string,
  settings: ProjectUpdatesSettings
) {
  productStorage.setItem(
    projectUpdatesSettingsStorageKey(workspaceId),
    JSON.stringify(projectUpdatesSettingsSchema.parse(settings))
  )
}
