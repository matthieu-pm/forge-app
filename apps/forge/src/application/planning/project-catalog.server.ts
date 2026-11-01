import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import type { Transaction } from "@/db"
import type { Actor } from "@/application/actor"
import { productState, projects } from "@/db"
import {
  initialProjectStatuses,
  projectStatusDirectorySchema,
  projectStatusValue,
  projectStatusesStorageKey,
} from "@/lib/project-statuses"
import {
  projectLabelsStorageKey,
  teamLabelDirectorySchema,
} from "@/lib/team-labels"

export function isProjectCatalog(key: string, workspaceId: string) {
  return (
    key === projectStatusesStorageKey(workspaceId) ||
    key === projectLabelsStorageKey
  )
}
export function parseProjectCatalog(key: string, value: string) {
  if (key.startsWith("forge:project-statuses:"))
    return projectStatusDirectorySchema.parse(JSON.parse(value))
  const directory = teamLabelDirectorySchema.parse(JSON.parse(value))
  const all = [...directory.labels, ...directory.groups]
  if (
    all.length > 1000 ||
    new Set(all.map((l) => l.id)).size !== all.length ||
    new Set(all.map((l) => l.name.toLowerCase())).size !== all.length ||
    directory.labels.some(
      (l) => l.groupId && !directory.groups.some((g) => g.id === l.groupId)
    )
  )
    throw new Error("Use unique label IDs and names, and valid groups.")
  return directory
}
export async function readProjectCatalog(tx: Transaction, actor: Actor) {
  const rows = await tx
    .select()
    .from(productState)
    .where(
      and(
        eq(productState.workspaceId, actor.workspaceId),
        eq(productState.ownerId, "workspace")
      )
    )
  const value = (key: string) => {
    const raw = rows.find((r) => r.key === key)?.encodedValue
    return raw ? JSON.parse(JSON.parse(raw)) : undefined
  }
  return {
    statuses: projectStatusDirectorySchema.parse(
      value(projectStatusesStorageKey(actor.workspaceId)) ??
        initialProjectStatuses()
    ),
    labels: teamLabelDirectorySchema.parse(
      value(projectLabelsStorageKey) ?? {
        version: 1,
        labels: [],
        groups: [],
        inheritedCount: 0,
      }
    ),
  }
}
export async function validateProjectCatalogChange(
  tx: Transaction,
  actor: Actor,
  key: string,
  value: string | null
) {
  if (!value)
    throw new Error(
      "Shared project catalogs cannot be cleared. Edit their entries instead."
    )
  const next = parseProjectCatalog(key, value)
  const rows = await tx
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, actor.workspaceId))
  if ("statuses" in next) {
    if (next.statuses.length > 500)
      throw new Error("Too many project statuses.")
    const current = (await readProjectCatalog(tx, actor)).statuses
    for (const row of rows) {
      const id = row.properties.statusId
      if (typeof id !== "string" || !id) continue
      const old = current.statuses.find((s) => s.id === id),
        status = next.statuses.find((s) => s.id === id)
      if (!status || (old && old.group !== status.group))
        throw new Error(
          "A status in use cannot be deleted or moved to another workflow group."
        )
    }
  } else {
    for (const row of rows)
      for (const id of (row.properties.labelIds as Array<string> | undefined) ??
        [])
        if (
          !next.labels.some((l) => l.id === id) &&
          !next.groups.some((g) => g.id === id)
        )
          throw new Error(
            "A label in use cannot be deleted. Archive it instead."
          )
  }
}
export { projectStatusValue }
