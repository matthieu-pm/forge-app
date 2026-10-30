import { z } from "zod"
import {
  sharedDefinitionsActive,
  sharedIssueLabels,
} from "./issue-definition-cache"

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
export const teamLabelDirectorySchema = z.object({
  version: z.literal(1),
  labels: z.array(labelSchema),
  groups: z.array(
    z.object({
      id: z.string(),
      name: z.string().trim().min(1).max(80),
      description: z.string().max(500),
      color: z.string().regex(/^#[0-9a-f]{6}$/i),
      createdAt: z.iso.datetime().optional(),
      issues: z.number().int().nonnegative().optional(),
      lastApplied: z.iso.datetime().nullable().optional(),
    })
  ),
  inheritedCount: z.number().int().nonnegative(),
})

export type TeamLabel = z.infer<typeof labelSchema>
export type TeamLabelDirectory = z.infer<typeof teamLabelDirectorySchema>
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
  return teamLabelDirectorySchema.parse(JSON.parse(value))
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

// Workspace reference fixture. Persisted directories always take precedence.
export function initialWorkspaceLabels(): TeamLabelDirectory {
  const createdAt = "2025-03-01T12:00:00Z"
  return {
    version: 1,
    inheritedCount: 0,
    groups: [
      {
        id: "design",
        name: "Design",
        color: "#5e6ad2",
        issues: 4,
        lastApplied: "2026-07-23T21:30:55Z",
      },
      {
        id: "direction",
        name: "Direction",
        color: "#eb5757",
        lastApplied: "2025-04-22T19:03:32Z",
      },
      {
        id: "marketing",
        name: "Marketing",
        color: "#26b5ce",
        lastApplied: "2025-08-12T12:16:44Z",
      },
      { id: "hr", name: "Ressources Humaines", color: "#f2c400" },
      {
        id: "sales",
        name: "Sales",
        color: "#4cb782",
        lastApplied: "2025-05-01T23:23:00Z",
      },
      { id: "service", name: "Service client", color: "#f2994a" },
      {
        id: "support",
        name: "Support",
        color: "#f7c5c0",
        issues: 10,
        lastApplied: "2026-04-06T23:29:51Z",
      },
      {
        id: "tech",
        name: "Tech",
        color: "#95a2b3",
        issues: 37,
        lastApplied: "2026-07-23T21:32:04Z",
      },
    ].map((group) => ({ ...group, description: "", createdAt })),
    labels: [
      { id: "ceo", name: "CEO Office", lastApplied: "2025-04-22T19:03:32Z" },
      {
        id: "ciao",
        name: "CIAO & Data, Intelligence Artificielle",
        lastApplied: "2025-04-02T18:41:41Z",
      },
      { id: "cmo", name: "CMO & Marketing", lastApplied: null },
      { id: "cto", name: "CTO & Technologie", lastApplied: null },
    ].map((label) => ({
      ...label,
      description: "",
      color: "#eb5757",
      groupId: "direction",
      issues: 0,
      createdAt,
    })),
  }
}

export const projectLabelsStorageKey = "forge:workspace-project-labels:v1"

// Project reference fixture, separate from issue labels and their usage counts.
export function initialProjectLabels(): TeamLabelDirectory {
  return {
    version: 1,
    inheritedCount: 0,
    labels: [],
    groups: [
      {
        id: "design",
        name: "Design",
        color: "#a78bfa",
        issues: 1,
        lastApplied: "2026-07-06T13:27:23Z",
      },
      {
        id: "development",
        name: "Development",
        color: "#38bdf8",
        issues: 3,
        lastApplied: "2026-07-06T13:27:23Z",
      },
      {
        id: "marketing",
        name: "Marketing",
        color: "#f2994a",
        issues: 0,
        lastApplied: "2026-04-06T16:55:46Z",
      },
      {
        id: "operations",
        name: "Operations",
        color: "#d4b43c",
        issues: 0,
        lastApplied: null,
      },
      {
        id: "product-management",
        name: "Product Management",
        color: "#4cb782",
        issues: 2,
        lastApplied: "2026-05-18T22:03:08Z",
      },
      {
        id: "sales",
        name: "Sales",
        color: "#eb5757",
        issues: 0,
        lastApplied: null,
      },
    ].map((group) => ({
      ...group,
      description: "",
      createdAt: "2026-04-01T12:00:00Z",
    })),
  }
}

export const initiativeLabelsStorageKey = "forge:workspace-initiative-labels:v1"

export function initialInitiativeLabels(): TeamLabelDirectory {
  return { version: 1, labels: [], groups: [], inheritedCount: 0 }
}

// During the shared session, no browser-local directory is consulted.
export function readTeamIssueLabels(
  teamId: string,
  slug = ""
): TeamLabelDirectory {
  if (sharedDefinitionsActive()) return sharedIssueLabels(teamId)
  const raw = localStorage.getItem(teamLabelsStorageKey(teamId))
  return raw ? parseTeamLabels(raw) : initialTeamLabels(slug)
}
