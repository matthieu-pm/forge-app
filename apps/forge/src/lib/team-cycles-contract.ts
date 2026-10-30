import { z } from "zod"

export const cyclesSchema = z.object({
  enabled: z.boolean(),
  duration: z.number().int().min(1).max(8),
  cooldown: z.number().int().min(0).max(4),
  startDay: z.number().int().min(0).max(6),
  futureCycles: z.number().int().min(1).max(6),
  activeIssues: z.boolean(),
  startedIssues: z.boolean(),
  completedIssues: z.boolean(),
})
export type TeamCyclesSettings = z.infer<typeof cyclesSchema>
export const teamCyclesStorageKey = (teamId: string) =>
  `forge:team-cycles:v1:${teamId}`
export const initialTeamCycles = (): TeamCyclesSettings => ({
  enabled: false,
  duration: 2,
  cooldown: 2,
  startDay: 1,
  futureCycles: 2,
  activeIssues: false,
  startedIssues: true,
  completedIssues: true,
})
export const parseTeamCycles = (raw: string) =>
  cyclesSchema.parse(JSON.parse(raw))
