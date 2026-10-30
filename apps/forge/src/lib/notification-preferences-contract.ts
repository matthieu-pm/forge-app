import { z } from "zod"

export const notificationTypes = [
  { id: "assignments", label: "Assignments" },
  { id: "status", label: "Status changes" },
  { id: "mentions", label: "Mentions" },
  { id: "comments", label: "Comments" },
  { id: "replies", label: "Replies" },
  { id: "reactions", label: "Reactions" },
  { id: "due-dates", label: "Due dates" },
  { id: "issue-updates", label: "Issue updates" },
  { id: "project-updates", label: "Project updates" },
  { id: "project-status", label: "Project status changes" },
  { id: "milestones", label: "Milestones" },
  { id: "cycles", label: "Cycle updates" },
  { id: "documents", label: "Document updates" },
  { id: "subscriptions", label: "Subscribed issues" },
  { id: "team-updates", label: "Team updates" },
  { id: "agent-updates", label: "Agent updates" },
] as const
export const notificationChannels = [
  "desktop",
  "mobile",
  "email",
  "slack",
] as const
export type NotificationChannel = (typeof notificationChannels)[number]
export type NotificationType = (typeof notificationTypes)[number]["id"]
const typesSchema = z
  .array(z.enum(notificationTypes.map((type) => type.id)))
  .refine((types) => new Set(types).size === types.length)
const channelSchema = z.object({ enabled: z.boolean(), types: typesSchema })
export const notificationPreferencesSchema = z.object({
  priorityInbox: z.boolean(),
  priorityTypes: typesSchema,
  channels: z.object({
    desktop: channelSchema,
    mobile: channelSchema,
    email: channelSchema,
    slack: channelSchema,
  }),
  updates: z.object({
    sidebar: z.boolean(),
    changelog: z.boolean(),
    marketing: z.boolean(),
    invite: z.boolean(),
    legal: z.boolean(),
    dpa: z.boolean(),
  }),
})
export type NotificationPreferences = z.infer<
  typeof notificationPreferencesSchema
>
export const notificationPreferencesKey = (userId: string) =>
  `forge:notifications:v1:${userId}`
export function initialNotificationPreferences(): NotificationPreferences {
  const all = notificationTypes.map((type) => type.id)
  return {
    priorityInbox: false,
    priorityTypes: all.slice(0, 11),
    channels: {
      desktop: { enabled: true, types: all.slice(0, 14) },
      mobile: { enabled: true, types: [...all] },
      email: { enabled: true, types: [...all] },
      slack: { enabled: false, types: [...all] },
    },
    updates: {
      sidebar: false,
      changelog: false,
      marketing: false,
      invite: true,
      legal: true,
      dpa: false,
    },
  }
}
