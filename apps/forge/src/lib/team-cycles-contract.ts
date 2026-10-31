import { z } from "zod"

export const cycleTimezoneSchema = z
  .string()
  .max(100)
  .refine((value) => {
    if (/^[+-]/.test(value)) return false
    try {
      new Intl.DateTimeFormat("en", { timeZone: value })
      return true
    } catch {
      return false
    }
  }, "Choose a valid IANA timezone.")
  .transform(
    (value) =>
      new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions()
        .timeZone
  )

export const cyclesSchema = z.object({
  enabled: z.boolean(),
  timezone: cycleTimezoneSchema.optional(),
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

export type SharedCycle = {
  id: string
  teamId: string
  number: number
  startDate: string
  endDate: string
  timezone: string
  issueCount: number
  completedCount: number
  state: "Current" | "Upcoming" | "Planned" | "Past"
}
export type SharedCycleSnapshot = {
  workspaceId: string
  userId: string
  sessionId: string
  settings: TeamCyclesSettings
  revision: number
  canManage: boolean
  cycles: Array<SharedCycle>
}
