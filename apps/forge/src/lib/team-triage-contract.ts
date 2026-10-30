import { z } from "zod"

export const triageSchema = z.object({
  enabled: z.boolean(),
  requirePriority: z.boolean(),
  action: z.enum(["none", "notify", "assign"]).optional(),
})
export type TeamTriageSettings = z.infer<typeof triageSchema>
export const teamTriageStorageKey = (teamId: string) =>
  `forge:team-triage:v1:${teamId}`
export const initialTeamTriage = (): TeamTriageSettings => ({
  enabled: false,
  requirePriority: false,
})
export const parseTeamTriage = (raw: string) =>
  triageSchema.parse(JSON.parse(raw))
