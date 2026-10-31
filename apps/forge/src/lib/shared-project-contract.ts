import { z } from "zod"
import { initiativeProjectSchema } from "./initiatives"
import { initiativeProjectCatalog } from "./initiative-projects"
import { stableJson } from "./stable-json"
import type { InitiativeStore } from "./initiatives"

export { projectCommandPrefix } from "./shared-project-key"
export const projectFields = initiativeProjectSchema
  .pick({
    name: true,
    status: true,
    teamIds: true,
    summary: true,
    description: true,
    icon: true,
    priority: true,
    leadId: true,
    memberIds: true,
    startDate: true,
    targetDate: true,
  })
  .extend({
    teamIds: z.array(z.uuid()).max(100),
    memberIds: z.array(z.string().min(1).max(200)).max(100).optional(),
    leadId: z.string().max(200).optional(),
  })
  .strict()
export const projectChangesSchema = z
  .array(
    z
      .object({
        id: z.uuid(),
        expectedRevision: z.number().int().nonnegative().nullable(),
        changes: projectFields.partial(),
      })
      .strict()
  )
  .min(1)
  .max(100)
export type ProjectChanges = z.infer<typeof projectChangesSchema>

/** Compare the projection the editor saw; never send hidden fields back. */
export function sharedProjectChanges(
  before: InitiativeStore,
  after: InitiativeStore
): ProjectChanges {
  const previous = new Map(
    initiativeProjectCatalog(before).map((p) => [p.id, p])
  )
  const next = initiativeProjectCatalog(after)
  if ([...previous.keys()].some((id) => !next.some((p) => p.id === id)))
    throw new Error(
      "Project deletion is unavailable until project lifecycle support is enabled."
    )
  const result: ProjectChanges = []
  for (const project of next) {
    const old = previous.get(project.id)
    const changes: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(project)) {
      if (
        ["id", "revision", "creatorId", "createdAt", "updatedAt"].includes(key)
      )
        continue
      if (stableJson(value) === stableJson(old?.[key as keyof typeof old]))
        continue
      if (!(key in projectFields.shape)) {
        // Empty optional fields on a new form carry no shared effect.
        if (
          !old &&
          (key === "health" ||
            (Array.isArray(value) && !value.length) ||
            value === "")
        )
          continue
        throw new Error(
          "Project milestones, updates, labels and dependencies are not available yet. Your draft has been kept."
        )
      }
      changes[key] = value
    }
    if (!old || Object.keys(changes).length)
      result.push({
        id: project.id,
        expectedRevision: old?.revision ?? null,
        changes,
      })
  }
  return result.length ? projectChangesSchema.parse(result) : []
}
