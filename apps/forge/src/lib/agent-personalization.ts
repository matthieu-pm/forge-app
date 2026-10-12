import { z } from "zod"

export const personalSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1, "Enter a skill name.").max(120),
  instructions: z
    .string()
    .trim()
    .min(1, "Add instructions for this skill.")
    .max(50000),
  createdAt: z.string().datetime(),
  revision: z.number().int().nonnegative(),
})
const personalizationSchema = z.object({
  guidance: z.string().max(50000),
  skills: z.array(personalSkillSchema),
})
export type PersonalSkill = z.infer<typeof personalSkillSchema>
export type AgentPersonalization = z.infer<typeof personalizationSchema>
export const personalizationStorageKey = (userId: string) =>
  `forge:agent-personalization:v1:${userId}`
export function readPersonalization(userId: string): AgentPersonalization {
  const raw = localStorage.getItem(personalizationStorageKey(userId))
  return raw
    ? personalizationSchema.parse(JSON.parse(raw))
    : { guidance: "", skills: [] }
}
export function writePersonalization(
  userId: string,
  update: (current: AgentPersonalization) => AgentPersonalization
) {
  const next = personalizationSchema.parse(update(readPersonalization(userId)))
  localStorage.setItem(personalizationStorageKey(userId), JSON.stringify(next))
  return next
}
export function replacePersonalSkill(
  current: AgentPersonalization,
  original: PersonalSkill,
  patch: Pick<PersonalSkill, "name" | "instructions"> | null
) {
  const saved = current.skills.find((skill) => skill.id === original.id)
  if (!saved || saved.revision !== original.revision)
    throw new Error(
      "This skill changed elsewhere. Reopen it before trying again."
    )
  return {
    ...current,
    skills:
      patch === null
        ? current.skills.filter((skill) => skill.id !== original.id)
        : current.skills.map((skill) =>
            skill.id === original.id
              ? { ...skill, ...patch, revision: skill.revision + 1 }
              : skill
          ),
  }
}
