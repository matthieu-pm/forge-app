import * as React from "react"
import { z } from "zod"
import { documentSchema } from "./template-contract"
import { productStorage } from "@/lib/product-storage"
import { useWorkspaceView } from "@/components/account-preference-provider"

export const teamResourceSchema = z.object({
  id: z.string(),
  kind: z.enum(["document", "link"]),
  title: z.string().trim().min(1).max(200),
  content: z.string().max(100000),
  sectionId: z.string().nullable(),
  updatedAt: z.string(),
  createdAt: z.string().optional(),
  body: documentSchema.optional(),
  icon: z
    .object({
      kind: z.enum(["icon", "emoji"]),
      value: z.string().min(1).max(100),
      color: z.string().regex(/^#[0-9a-f]{6}$/i),
    })
    .optional(),
  owner: z
    .object({
      id: z.string(),
      name: z.string(),
      image: z.string().nullable().optional(),
    })
    .optional(),
  favorite: z.boolean().optional(),
})
export const teamHomeSchema = z.object({
  favorite: z.boolean(),
  sections: z.array(
    z.object({
      id: z.string(),
      name: z.string().trim().min(1).max(80),
      collapsed: z.boolean(),
    })
  ),
  resources: z.array(teamResourceSchema),
  loops: z.array(
    z.object({
      id: z.string(),
      name: z.string().trim().min(1).max(200),
      prompt: z.string().max(20000),
      trigger: z.string(),
      updatedAt: z.string(),
    })
  ),
})
export type TeamHomeState = z.infer<typeof teamHomeSchema>
export type TeamResource = z.infer<typeof teamResourceSchema>
export type LoopDraft = TeamHomeState["loops"][number]
export const emptyTeamHome = (): TeamHomeState => ({
  favorite: false,
  sections: [],
  resources: [],
  loops: [],
})
export const teamHomeKey = (teamId: string) => `forge:team-home:v1:${teamId}`
export function safeResourceUrl(value: string) {
  try {
    const url = new URL(value)
    return ["https:", "http:"].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}
export function removeHomeSection(
  state: TeamHomeState,
  id: string
): TeamHomeState {
  return {
    ...state,
    sections: state.sections.filter((section) => section.id !== id),
    resources: state.resources.map((resource) =>
      resource.sectionId === id ? { ...resource, sectionId: null } : resource
    ),
  }
}
const changed = "forge:team-home-changed"
export function useTeamHome(teamId: string) {
  const sync = useWorkspaceView("teamHome", teamId)
  const key = teamHomeKey(teamId)
  const [state, setState] = React.useState(emptyTeamHome)
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    const load = () => {
      try {
        const raw = productStorage.getItem(key)
        setState(raw ? teamHomeSchema.parse(JSON.parse(raw)) : emptyTeamHome())
        setError(null)
      } catch {
        setError(
          "Saved team content could not be loaded. Your data has been preserved. Reload to try again."
        )
      }
      setReady(true)
    }
    const sync = (event: Event) => {
      if (
        event instanceof StorageEvent
          ? event.key === key || event.key === null
          : (event as CustomEvent).detail === key
      )
        load()
    }
    load()
    window.addEventListener("storage", sync)
    window.addEventListener(changed, sync)
    return () => {
      window.removeEventListener("storage", sync)
      window.removeEventListener(changed, sync)
    }
  }, [key])
  function overlay(current: TeamHomeState): TeamHomeState {
    return {
      ...current,
      favorite: sync.value.favorite,
      sections: current.sections.map((section) => ({
        ...section,
        collapsed: sync.value.collapsedSectionIds.includes(section.id),
      })),
      resources: current.resources.map((resource) => ({
        ...resource,
        favorite: sync.value.favoriteResourceIds.includes(resource.id),
      })),
    }
  }
  function update(reducer: (current: TeamHomeState) => TeamHomeState) {
    if (!ready || error) return false
    try {
      const raw = productStorage.getItem(key),
        current = raw ? teamHomeSchema.parse(JSON.parse(raw)) : emptyTeamHome()
      const next = teamHomeSchema.parse(reducer(overlay(current)))
      const personal = {
        favorite: next.favorite,
        collapsedSectionIds: next.sections
          .filter((section) => section.collapsed)
          .map((section) => section.id),
        favoriteResourceIds: next.resources
          .filter((resource) => resource.favorite)
          .map((resource) => resource.id),
      }
      if (
        JSON.stringify(personal) !== JSON.stringify(sync.value) &&
        !sync.save(personal)
      )
        return false
      const business = {
        ...next,
        favorite: current.favorite,
        sections: next.sections.map((section) => ({
          ...section,
          collapsed:
            current.sections.find((previous) => previous.id === section.id)
              ?.collapsed ?? false,
        })),
        resources: next.resources.map((resource) => ({
          ...resource,
          favorite:
            current.resources.find((previous) => previous.id === resource.id)
              ?.favorite ?? false,
        })),
      }
      if (JSON.stringify(business) !== JSON.stringify(current)) {
        productStorage.setItem(key, JSON.stringify(business))
        setState(business)
        window.dispatchEvent(new CustomEvent(changed, { detail: key }))
      }
      return true
    } catch {
      return false
    }
  }
  return { state: overlay(state), ready, error, update }
}
export type HomeStore = ReturnType<typeof useTeamHome>
