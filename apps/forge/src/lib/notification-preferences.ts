import * as React from "react"
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
export function channelSummary(
  channel: NotificationPreferences["channels"][NotificationChannel]
) {
  if (!channel.enabled || !channel.types.length) return "Disabled"
  if (channel.types.length === notificationTypes.length)
    return "Enabled for all notifications"
  const labels = notificationTypes
    .filter((type) => channel.types.includes(type.id))
    .map((type) => type.label.toLowerCase())
  return `Enabled for ${labels.slice(0, 2).join(", ")}${labels.length > 2 ? `, ${labels.length - 2} ${labels.length === 3 ? "other" : "others"}` : ""}`
}
const changeEvent = "forge:notifications-changed"
export function useNotificationPreferences(userId: string) {
  const storageKey = notificationPreferencesKey(userId)
  const [settings, setSettings] = React.useState(initialNotificationPreferences)
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    function load() {
      try {
        const raw = localStorage.getItem(storageKey)
        setSettings(
          raw
            ? notificationPreferencesSchema.parse(JSON.parse(raw))
            : initialNotificationPreferences()
        )
        setError(null)
      } catch {
        setError(
          "Saved notification settings could not be loaded. Your data has been preserved. Reload to try again."
        )
      }
      setReady(true)
    }
    function storage(event: StorageEvent) {
      if (event.key === storageKey || event.key === null) load()
    }
    function change(event: Event) {
      if ((event as CustomEvent<string>).detail === storageKey) load()
    }
    load()
    window.addEventListener("storage", storage)
    window.addEventListener(changeEvent, change)
    return () => {
      window.removeEventListener("storage", storage)
      window.removeEventListener(changeEvent, change)
    }
  }, [storageKey])
  function update(
    change: (current: NotificationPreferences) => NotificationPreferences
  ) {
    if (!ready || error) return false
    try {
      const raw = localStorage.getItem(storageKey)
      const current = raw
        ? notificationPreferencesSchema.parse(JSON.parse(raw))
        : initialNotificationPreferences()
      const next = notificationPreferencesSchema.parse(change(current))
      localStorage.setItem(storageKey, JSON.stringify(next))
      setSettings(next)
      window.dispatchEvent(new CustomEvent(changeEvent, { detail: storageKey }))
      return true
    } catch {
      return false
    }
  }
  return { settings, ready, error, update }
}
