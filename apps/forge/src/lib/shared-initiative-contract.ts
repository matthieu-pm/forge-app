import { z } from "zod"
import { initiativeSchema } from "./initiatives"
import { stableJson } from "./stable-json"
import type { InitiativeStore } from "./initiatives"

export const initiativeFields = initiativeSchema
  .pick({
    name: true,
    summary: true,
    description: true,
    icon: true,
    status: true,
    priority: true,
    ownerId: true,
    targetDate: true,
    updates: true,
    comments: true,
  })
  .extend({
    ownerId: z.string().max(200),
    updates: initiativeSchema.shape.updates.max(500),
    comments: initiativeSchema.shape.comments.unwrap().max(500),
  })
  .strict()
export const initiativeChangesSchema = z
  .array(
    z
      .object({
        id: z.uuid(),
        expectedRevision: z.number().int().nonnegative().nullable(),
        changes: initiativeFields.partial(),
        addProjectIds: z.array(z.uuid()).max(500).default([]),
        removeProjectIds: z.array(z.uuid()).max(500).default([]),
      })
      .strict()
  )
  .min(1)
  .max(100)
export type InitiativeChanges = z.infer<typeof initiativeChangesSchema>
export function sharedInitiativeChanges(
  before: InitiativeStore,
  after: InitiativeStore
): InitiativeChanges {
  if (
    before.initiatives.some(
      (i) => !after.initiatives.some((n) => n.id === i.id)
    )
  )
    throw new Error(
      "Initiative deletion is not available yet. Your changes have been kept."
    )
  const result: InitiativeChanges = []
  for (const item of after.initiatives) {
    const old = before.initiatives.find((i) => i.id === item.id)
    if (old && old.revision !== item.revision)
      throw new Error(
        "This initiative changed while editing. Review the latest version before saving."
      )
    const changes: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(item)) {
      if (
        [
          "id",
          "revision",
          "rollup",
          "number",
          "createdAt",
          "updatedAt",
          "completedAt",
          "creatorId",
          "projects",
        ].includes(key)
      )
        continue
      if (stableJson(value) === stableJson(old?.[key as keyof typeof old]))
        continue
      if (!(key in initiativeFields.shape)) {
        if (!old && Array.isArray(value) && !value.length) continue
        throw new Error(
          "Initiative labels, resources and saved views are not available yet. Your draft has been kept."
        )
      }
      changes[key] = value
    }
    const addProjectIds = item.projects
      .filter((p) => !old?.projects.some((o) => o.id === p.id))
      .map((p) => p.id)
    const removeProjectIds =
      old?.projects
        .filter((p) => !item.projects.some((n) => n.id === p.id))
        .map((p) => p.id) ?? []
    if (
      !old ||
      Object.keys(changes).length ||
      addProjectIds.length ||
      removeProjectIds.length
    )
      result.push({
        id: item.id,
        expectedRevision: old?.revision ?? null,
        changes,
        addProjectIds,
        removeProjectIds,
      })
  }
  return result.length ? initiativeChangesSchema.parse(result) : []
}
