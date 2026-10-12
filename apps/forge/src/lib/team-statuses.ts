import { z } from "zod"

export const statusGroups = [
  { id: "backlog", name: "Backlog", color: "#bec2c8" },
  { id: "unstarted", name: "Unstarted", color: "#bec2c8" },
  { id: "started", name: "Started", color: "#f2c400" },
  { id: "completed", name: "Completed", color: "#5e6ad2" },
  { id: "canceled", name: "Canceled", color: "#95a2b3" },
  { id: "duplicate", name: "Duplicate", color: "#95a2b3" },
] as const
export type StatusGroup = (typeof statusGroups)[number]["id"]
const statusSchema = z.object({
  id: z.string().min(1),
  group: z.enum([
    "backlog",
    "unstarted",
    "started",
    "completed",
    "canceled",
    "duplicate",
  ]),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(240),
  color: z.string().regex(/^#[\da-f]{6}$/i),
})
export type TeamStatus = z.infer<typeof statusSchema>
const directorySchema = z
  .object({
    statuses: z.array(statusSchema),
    defaultId: z.string(),
  })
  .superRefine(({ statuses, defaultId }, context) => {
    const ids = new Set(statuses.map((status) => status.id))
    const names = new Set(statuses.map((status) => status.name.toLowerCase()))
    if (
      ids.size !== statuses.length ||
      names.size !== statuses.length ||
      !statuses.some(
        (status) => status.id === defaultId && status.group !== "duplicate"
      ) ||
      statusGroups.some(
        (group) => !statuses.some((status) => status.group === group.id)
      ) ||
      statuses.filter((status) => status.group === "duplicate").length !== 1
    ) {
      context.addIssue({
        code: "custom",
        message: "Invalid workflow statuses.",
      })
    }
  })
export type TeamStatusDirectory = z.infer<typeof directorySchema>
export const teamStatusesStorageKey = (teamId: string) =>
  `forge:team-statuses:v1:${teamId}`
export const parseTeamStatuses = (raw: string) =>
  directorySchema.parse(JSON.parse(raw))
export function initialTeamStatuses(): TeamStatusDirectory {
  return {
    defaultId: "backlog",
    statuses: [
      {
        id: "backlog",
        group: "backlog",
        name: "Backlog",
        description: "",
        color: "#bec2c8",
      },
      {
        id: "todo",
        group: "unstarted",
        name: "Todo",
        description: "",
        color: "#bec2c8",
      },
      {
        id: "in-progress",
        group: "started",
        name: "In Progress",
        description: "",
        color: "#f2c400",
      },
      {
        id: "in-review",
        group: "started",
        name: "In Review",
        description: "Pull request is being reviewed",
        color: "#4cb782",
      },
      {
        id: "done",
        group: "completed",
        name: "Done",
        description: "",
        color: "#5e6ad2",
      },
      {
        id: "canceled",
        group: "canceled",
        name: "Canceled",
        description: "",
        color: "#95a2b3",
      },
      {
        id: "duplicate",
        group: "duplicate",
        name: "Duplicate",
        description: "",
        color: "#95a2b3",
      },
    ],
  }
}
