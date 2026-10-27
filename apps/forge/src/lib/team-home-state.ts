import * as React from "react"
import { z } from "zod"
import { documentSchema } from "./template-contract"

const resourceSchema = z.object({
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
  resources: z.array(resourceSchema),
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
export type TeamResource = z.infer<typeof resourceSchema>
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
  const key = teamHomeKey(teamId)
  const [state, setState] = React.useState(emptyTeamHome)
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    const load = () => {
      try {
        const raw = localStorage.getItem(key)
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
  function update(reducer: (current: TeamHomeState) => TeamHomeState) {
    if (!ready || error) return false
    try {
      const raw = localStorage.getItem(key)
      const next = teamHomeSchema.parse(
        reducer(raw ? teamHomeSchema.parse(JSON.parse(raw)) : emptyTeamHome())
      )
      localStorage.setItem(key, JSON.stringify(next))
      setState(next)
      window.dispatchEvent(new CustomEvent(changed, { detail: key }))
      return true
    } catch {
      return false
    }
  }
  return { state, ready, error, update }
}
export type HomeStore = ReturnType<typeof useTeamHome>
