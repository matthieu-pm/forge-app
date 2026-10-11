import { z } from "zod"

export const LABEL_COLORS = [
  "#5b6478",
  "#8b5cf6",
  "#5e6ad2",
  "#38bdf8",
  "#34d399",
  "#facc15",
  "#fb923c",
  "#fb7185",
] as const

const labelSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  groupId: z.string().nullable(),
  issues: z.number().int().nonnegative(),
  lastApplied: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  favorite: z.boolean().optional(),
  archived: z.boolean().optional(),
})
const directorySchema = z.object({
  version: z.literal(1),
  labels: z.array(labelSchema),
  groups: z.array(
    z.object({
      id: z.string(),
      name: z.string().trim().min(1).max(80),
      description: z.string().max(500),
      color: z.string().regex(/^#[0-9a-f]{6}$/i),
    })
  ),
  inheritedCount: z.number().int().nonnegative(),
})

export type TeamLabel = z.infer<typeof labelSchema>
export type TeamLabelDirectory = z.infer<typeof directorySchema>
export type TeamLabelGroup = TeamLabelDirectory["groups"][number]

// Reference data for the frontend settings experience, until labels have a server model.
export function initialTeamLabels(slug: string): TeamLabelDirectory {
  return {
    version: 1,
    groups: [],
    inheritedCount: slug === "forge" ? 123 : 0,
    labels:
      slug === "forge"
        ? [
            {
              id: "desktop",
              name: "Desktop",
              description:
                "Electron desktop application behavior and native integrations.",
              color: LABEL_COLORS[0],
              groupId: null,
              issues: 4,
              lastApplied: "2026-07-23T12:00:00Z",
              createdAt: "2026-07-23T12:00:00Z",
            },
            {
              id: "preferences",
              name: "Preferences",
              description:
                "Personal preferences, settings behavior, and preference persistence.",
              color: LABEL_COLORS[1],
              groupId: null,
              issues: 17,
              lastApplied: "2026-07-23T12:00:00Z",
              createdAt: "2026-07-23T12:00:00Z",
            },
          ]
        : [],
  }
}

export function teamLabelsStorageKey(teamId: string) {
  return `forge:team-issue-labels:${teamId}:v1`
}

export function parseTeamLabels(value: string): TeamLabelDirectory {
  return directorySchema.parse(JSON.parse(value))
}

export function restoreTeamLabelDeletion(
  current: TeamLabelDirectory,
  previous: TeamLabelDirectory,
  id: string,
  kind: "label" | "group"
): TeamLabelDirectory | null {
  if (kind === "label") {
    const removed = previous.labels.find((label) => label.id === id)
    if (
      !removed ||
      current.labels.some(
        (label) =>
          label.id === id ||
          label.name.toLocaleLowerCase() === removed.name.toLocaleLowerCase()
      )
    )
      return null
    return {
      ...current,
      labels: [
        ...current.labels,
        {
          ...removed,
          groupId: current.groups.some((group) => group.id === removed.groupId)
            ? removed.groupId
            : null,
        },
      ],
    }
  }
  const removed = previous.groups.find((group) => group.id === id)
  if (
    !removed ||
    current.groups.some(
      (group) =>
        group.id === id ||
        group.name.toLocaleLowerCase() === removed.name.toLocaleLowerCase()
    )
  )
    return null
  const groupedIds = new Set(
    previous.labels
      .filter((label) => label.groupId === id)
      .map((label) => label.id)
  )
  return {
    ...current,
    groups: [...current.groups, removed],
    labels: current.labels.map((label) =>
      !label.groupId && groupedIds.has(label.id)
        ? { ...label, groupId: id }
        : label
    ),
  }
}

export const workspaceLabelsStorageKey = "forge:workspace-issue-labels:v1"

export function mergeTeamLabels(
  directory: TeamLabelDirectory,
  ids: Array<string>,
  targetId: string
): TeamLabelDirectory | null {
  const selected = directory.labels.filter((label) => ids.includes(label.id))
  const target = selected.find((label) => label.id === targetId)
  if (!target || selected.length < 2) return null
  const appliedDates = selected
    .map((label) => label.lastApplied)
    .filter((date): date is string => date !== null)
    .sort()
  return {
    ...directory,
    labels: [
      ...directory.labels.filter((label) => !ids.includes(label.id)),
      {
        ...target,
        issues: selected.reduce((sum, label) => sum + label.issues, 0),
        lastApplied: appliedDates.at(-1) ?? null,
        favorite: selected.some((label) => label.favorite),
      },
    ],
  }
}
