import { useCallback, useMemo, useSyncExternalStore } from "react"
import {
  customViewSchema,
  customViewsKey,
  parseCustomViews,
} from "./custom-views"
import type { WorkspaceViewValues } from "./workspace-preference-contract"
import type { CustomView } from "./custom-views"
import { useWorkspaceView } from "@/components/account-preference-provider"

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
  const favorites = useWorkspaceView("directory", "main", {
    workspaceId,
    userId,
  })
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
      const visible = current.views.map((view) => ({
        ...view,
        favorite: favorites.value.favoriteIds.includes(view.id),
      }))
      const views = transform(visible)
      const favoriteIds = views
        .filter((view) => view.favorite)
        .map((view) => view.id)
      if (
        JSON.stringify(favoriteIds) !==
          JSON.stringify(favorites.value.favoriteIds) &&
        !favorites.save({ ...favorites.value, favoriteIds })
      )
        return false
      localStorage.setItem(
        key,
        JSON.stringify({
          ...current,
          views: views.map((view) => ({
            ...view,
            favorite:
              current.views.find((previous) => previous.id === view.id)
                ?.favorite ?? false,
          })),
        })
      )
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
  return {
    ...result,
    views: result.views.map((view) => ({
      ...view,
      favorite: favorites.value.favoriteIds.includes(view.id),
    })),
    save,
    remove,
  }
}

export type CustomViewDirectoryPreferences = Omit<
  WorkspaceViewValues<"directory">,
  "favoriteIds"
>
export function useCustomViewDirectoryPreferences(
  workspaceId: string,
  userId: string
) {
  const sync = useWorkspaceView("directory", "main", { workspaceId, userId })
  return {
    ...sync.value,
    error: sync.error,
    save: (next: CustomViewDirectoryPreferences) =>
      sync.save({ ...sync.value, ...next }),
  }
}
