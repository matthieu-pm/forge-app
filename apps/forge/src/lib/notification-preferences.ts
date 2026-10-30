import * as React from "react"
import {
  initialNotificationPreferences,
  notificationPreferencesKey,
  notificationPreferencesSchema,
  notificationTypes,
} from "./notification-preferences-contract"
import type {
  NotificationChannel,
  NotificationPreferences,
} from "./notification-preferences-contract"
import { productStorage } from "@/lib/product-storage"

export * from "./notification-preferences-contract"
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
        const raw = productStorage.getItem(storageKey)
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
      const raw = productStorage.getItem(storageKey)
      const current = raw
        ? notificationPreferencesSchema.parse(JSON.parse(raw))
        : initialNotificationPreferences()
      const next = notificationPreferencesSchema.parse(change(current))
      productStorage.setItem(storageKey, JSON.stringify(next))
      setSettings(next)
      window.dispatchEvent(new CustomEvent(changeEvent, { detail: storageKey }))
      return true
    } catch {
      return false
    }
  }
  return { settings, ready, error, update }
}
