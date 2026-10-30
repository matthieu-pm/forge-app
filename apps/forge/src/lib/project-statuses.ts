import { z } from "zod"
import { productStorage } from "@/lib/product-storage"

export const projectStatusGroups = [
  { id: "backlog", name: "Backlog", color: "#95a2b3" },
  { id: "planned", name: "Planned", color: "#bec2c8" },
  { id: "in-progress", name: "In Progress", color: "#f2c400" },
  { id: "completed", name: "Completed", color: "#5e6ad2" },
  { id: "canceled", name: "Canceled", color: "#95a2b3" },
] as const
export const projectStatusSchema = z.object({
  id: z.string().min(1),
  group: z.enum(["backlog", "planned", "in-progress", "completed", "canceled"]),
  name: z.string().trim().min(1, "Enter a status name.").max(80),
  description: z.string().trim().max(240),
  color: z.string().regex(/^#[\da-f]{6}$/i, "Enter a six-digit hex color."),
})
export type ProjectStatus = z.infer<typeof projectStatusSchema>
const directorySchema = z
  .object({
    version: z.number().int().nonnegative(),
    statuses: z.array(projectStatusSchema),
    deleted: z.array(
      projectStatusSchema.extend({ index: z.number().int().nonnegative() })
    ),
  })
  .superRefine(({ statuses, deleted }, context) => {
    const ids = [...statuses, ...deleted].map((status) => status.id)
    const names = statuses.map((status) => status.name.toLowerCase())
    if (
      new Set(ids).size !== ids.length ||
      new Set(names).size !== names.length ||
      projectStatusGroups.some(
        (group) => !statuses.some((status) => status.group === group.id)
      )
    )
      context.addIssue({
        code: "custom",
        message:
          "Every workflow group needs a status, with unique names and IDs.",
      })
  })
export type ProjectStatusDirectory = z.infer<typeof directorySchema>
export function initialProjectStatuses(): ProjectStatusDirectory {
  return {
    version: 0,
    deleted: [],
    statuses: projectStatusGroups.map((group) => ({
      id: group.id,
      group: group.id,
      name: group.id === "planned" ? "To do" : group.name,
      color: group.color,
      description: "",
    })),
  }
}
export const projectStatusesStorageKey = (workspaceId: string) =>
  `forge:project-statuses:v1:${workspaceId}`
export function readProjectStatuses(workspaceId: string) {
  const raw = productStorage.getItem(projectStatusesStorageKey(workspaceId))
  return raw ? directorySchema.parse(JSON.parse(raw)) : initialProjectStatuses()
}
export function writeProjectStatuses(
  workspaceId: string,
  expectedVersion: number,
  change: (current: ProjectStatusDirectory) => ProjectStatusDirectory
) {
  const current = readProjectStatuses(workspaceId)
  if (current.version !== expectedVersion)
    throw new Error("Statuses changed elsewhere. Reload before trying again.")
  const next = directorySchema.parse({
    ...change(current),
    version: current.version + 1,
  })
  try {
    productStorage.setItem(
      projectStatusesStorageKey(workspaceId),
      JSON.stringify(next)
    )
  } catch {
    throw new Error("Your changes could not be saved. Please try again.")
  }
  return next
}
export function saveProjectStatus(
  current: ProjectStatusDirectory,
  status: ProjectStatus
) {
  const validated = projectStatusSchema.safeParse(status)
  if (!validated.success) throw new Error(validated.error.issues[0].message)
  const next = validated.data
  if (
    current.statuses.some(
      (item) =>
        item.id !== next.id &&
        item.name.toLowerCase() === next.name.toLowerCase()
    )
  )
    throw new Error("A status with this name already exists.")
  return {
    ...current,
    statuses: current.statuses.some((item) => item.id === next.id)
      ? current.statuses.map((item) => (item.id === next.id ? next : item))
      : [...current.statuses, next],
  }
}
export function deleteProjectStatus(
  current: ProjectStatusDirectory,
  id: string
) {
  const status = current.statuses.find((item) => item.id === id)
  if (!status) throw new Error("This status no longer exists.")
  if (
    current.statuses.filter((item) => item.group === status.group).length === 1
  )
    throw new Error("Keep at least one status in each workflow group.")
  return {
    ...current,
    statuses: current.statuses.filter((item) => item.id !== id),
    deleted: [
      ...current.deleted,
      {
        ...status,
        index: current.statuses.findIndex((item) => item.id === id),
      },
    ],
  }
}
export function restoreProjectStatus(
  current: ProjectStatusDirectory,
  id: string
) {
  const status = current.deleted.find((item) => item.id === id)
  if (!status) throw new Error("This status has already been restored.")
  const restored = saveProjectStatus(
    { ...current, deleted: current.deleted.filter((item) => item.id !== id) },
    status
  )
  const statuses = restored.statuses.filter((item) => item.id !== id)
  statuses.splice(
    Math.min(status.index, statuses.length),
    0,
    projectStatusSchema.parse(status)
  )
  return { ...restored, statuses }
}
export function moveProjectStatus(
  current: ProjectStatusDirectory,
  id: string,
  direction: -1 | 1
) {
  const status = current.statuses.find((item) => item.id === id)
  if (!status) throw new Error("This status no longer exists.")
  const group = current.statuses.filter((item) => item.group === status.group)
  const targetIndex = group.findIndex((item) => item.id === id) + direction
  if (targetIndex < 0) return current
  const target = group.at(targetIndex)
  if (!target) return current
  const statuses = [...current.statuses]
  const from = statuses.findIndex((item) => item.id === id)
  const to = statuses.findIndex((item) => item.id === target.id)
  ;[statuses[from], statuses[to]] = [statuses[to], statuses[from]]
  return { ...current, statuses }
}
