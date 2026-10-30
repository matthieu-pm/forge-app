import {
  personalizationSchema,
  personalizationStorageKey,
} from "./agent-personalization-contract"
import type {
  AgentPersonalization,
  PersonalSkill,
} from "./agent-personalization-contract"
import { productStorage } from "@/lib/product-storage"

export * from "./agent-personalization-contract"
export function readPersonalization(userId: string): AgentPersonalization {
  const raw = productStorage.getItem(personalizationStorageKey(userId))
  return raw
    ? personalizationSchema.parse(JSON.parse(raw))
    : { guidance: "", skills: [] }
}
export function writePersonalization(
  userId: string,
  update: (current: AgentPersonalization) => AgentPersonalization
) {
  const next = personalizationSchema.parse(update(readPersonalization(userId)))
  productStorage.setItem(
    personalizationStorageKey(userId),
    JSON.stringify(next)
  )
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
