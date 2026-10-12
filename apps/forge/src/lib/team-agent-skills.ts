import * as React from "react"
import { z } from "zod"

export const agentSkillSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  name: z.string().trim().min(1, "Enter a skill name.").max(120),
  instructions: z
    .string()
    .trim()
    .min(1, "Add instructions for this skill.")
    .max(50000),
  createdAt: z.string().datetime(),
  revision: z.number().int().nonnegative(),
})
const storeSchema = z.array(agentSkillSchema)
export type TeamAgentSkill = z.infer<typeof agentSkillSchema>
export const agentSkillsStorageKey = "forge:team-agent-skills:v1"
const changeEvent = "forge:team-agent-skills-changed"
export const parseAgentSkills = (raw: string) =>
  storeSchema.parse(JSON.parse(raw))
export function readAgentSkills() {
  const raw = localStorage.getItem(agentSkillsStorageKey)
  return raw ? parseAgentSkills(raw) : []
}
export function writeAgentSkills(
  change: (current: Array<TeamAgentSkill>) => Array<TeamAgentSkill>
) {
  const next = storeSchema.parse(change(readAgentSkills()))
  localStorage.setItem(agentSkillsStorageKey, JSON.stringify(next))
  window.dispatchEvent(new Event(changeEvent))
}
export function replaceAgentSkill(
  current: Array<TeamAgentSkill>,
  original: TeamAgentSkill,
  patch: Partial<
    Pick<TeamAgentSkill, "name" | "instructions" | "teamId">
  > | null
) {
  const saved = current.find(
    (skill) => skill.id === original.id && skill.teamId === original.teamId
  )
  if (!saved || saved.revision !== original.revision)
    throw new Error("This skill changed elsewhere. Reload before trying again.")
  return patch === null
    ? current.filter((skill) => skill.id !== original.id)
    : current.map((skill) =>
        skill.id === original.id
          ? { ...skill, ...patch, revision: skill.revision + 1 }
          : skill
      )
}
export function useAgentSkills() {
  const [skills, setSkills] = React.useState<Array<TeamAgentSkill>>([])
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    function load() {
      try {
        setSkills(readAgentSkills())
        setError(null)
      } catch {
        setError(
          "Saved skills could not be loaded. Your data has been preserved. Reload to try again."
        )
      }
      setReady(true)
    }
    function storage(event: StorageEvent) {
      if (event.key === agentSkillsStorageKey || event.key === null) load()
    }
    load()
    window.addEventListener("storage", storage)
    window.addEventListener(changeEvent, load)
    return () => {
      window.removeEventListener("storage", storage)
      window.removeEventListener(changeEvent, load)
    }
  }, [])
  return { skills, ready, error }
}
