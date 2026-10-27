import { useCallback, useMemo, useSyncExternalStore } from "react"
import { z } from "zod"
import {
  customViewSchema,
  customViewsKey,
  parseCustomViews,
} from "./custom-views"
import type { CustomView } from "./custom-views"

const changed = "forge:custom-views-changed"
const errorMessage =
  "Saved views could not be loaded. Your existing data has been preserved."
function subscribe(notify: () => void) {
  for (const event of ["storage", "focus", changed])
    window.addEventListener(event, notify)
  return () => {
    for (const event of ["storage", "focus", changed])
      window.removeEventListener(event, notify)
  }
}

export function useCustomViews(workspaceId: string, userId: string) {
  const key = customViewsKey(workspaceId, userId)
  const raw = useSyncExternalStore(
    subscribe,
    useCallback(() => {
      try {
        return localStorage.getItem(key)
      } catch {
        return "unavailable"
      }
    }, [key]),
    () => null
  )
  const result = useMemo(() => {
    try {
      return { views: parseCustomViews(raw).views, error: "" }
    } catch {
      return { views: [] as Array<CustomView>, error: errorMessage }
    }
  }, [raw])
  function update(transform: (views: Array<CustomView>) => Array<CustomView>) {
    try {
      // Read again at write time so another open view's changes are preserved.
      const current = parseCustomViews(localStorage.getItem(key))
      const views = transform(current.views)
      localStorage.setItem(key, JSON.stringify({ ...current, views }))
      window.dispatchEvent(new Event(changed))
      return true
    } catch {
      return false
    }
  }
  function save(view: CustomView) {
    return update((views) => {
      const existing = views.find((entry) => entry.id === view.id)
      const next = customViewSchema.parse({
        ...view,
        createdAt: existing?.createdAt ?? view.createdAt,
        updatedAt: new Date().toISOString(),
      })
      return existing
        ? views.map((entry) => (entry.id === next.id ? next : entry))
        : [...views, next]
    })
  }
  function remove(id: string) {
    return update((views) => views.filter((view) => view.id !== id))
  }
  return { ...result, save, remove }
}

const directoryPreferencesSchema = z.object({
  ordering: z.enum(["Name", "Created", "Updated"]),
  descending: z.boolean(),
  properties: z.array(z.enum(["Owner", "Created", "Updated"])),
})
export type CustomViewDirectoryPreferences = z.infer<
  typeof directoryPreferencesSchema
>
const defaultDirectoryPreferences = (): CustomViewDirectoryPreferences => ({
  ordering: "Name",
  descending: false,
  properties: ["Owner"],
})
function parseDirectoryPreferences(raw: string | null) {
  return raw === null
    ? defaultDirectoryPreferences()
    : directoryPreferencesSchema.parse(JSON.parse(raw))
}

export function useCustomViewDirectoryPreferences(
  workspaceId: string,
  userId: string
) {
  const key = `${customViewsKey(workspaceId, userId)}:directory`
  const raw = useSyncExternalStore(
    subscribe,
    useCallback(() => {
      try {
        return localStorage.getItem(key)
      } catch {
        return "unavailable"
      }
    }, [key]),
    () => null
  )
  const result = useMemo(() => {
    try {
      return { ...parseDirectoryPreferences(raw), error: "" }
    } catch {
      return {
        ...defaultDirectoryPreferences(),
        error:
          "View directory preferences could not be loaded. Your saved settings have been preserved.",
      }
    }
  }, [raw])
  function save(preferences: CustomViewDirectoryPreferences) {
    try {
      // Check the current value as another tab may have written since rendering.
      parseDirectoryPreferences(localStorage.getItem(key))
      const next = directoryPreferencesSchema.parse(preferences)
      localStorage.setItem(key, JSON.stringify(next))
      window.dispatchEvent(new Event(changed))
      return true
    } catch {
      return false
    }
  }
  return { ...result, save }
}
