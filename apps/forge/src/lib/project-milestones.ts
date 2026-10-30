import { format, isValid, parseISO } from "date-fns"
import { initiativeProjectCatalog } from "./initiative-projects"
import {
  initiativeStoreSchema,
  initiativesStorageKey,
  targetLabel,
} from "./initiatives"
import { saveWorkspaceProject } from "./projects"
import {
  ISSUES_CHANGED,
  readIssueStore,
  teamIssuesKey,
  writeIssueStore,
} from "./team-issues"
import type { InitiativeProject } from "./initiatives"
import type { TeamIssue } from "./team-issues"
import { productStorage } from "@/lib/product-storage"

export type ProjectMilestone = NonNullable<
  InitiativeProject["milestones"]
>[number]
export type MilestoneIssue = { issue: TeamIssue; completed: boolean }
export const NO_MILESTONE = "__none__"
export function matchesProject(
  issue: TeamIssue,
  teamId: string,
  project: InitiativeProject
) {
  return (
    issue.project === project.id ||
    (project.teamIds.includes(teamId) && issue.project === project.name)
  )
}
export function matchesMilestone(
  milestone: Pick<ProjectMilestone, "id" | "name" | "aliases">,
  value: string
) {
  return (
    value === milestone.id ||
    value === milestone.name ||
    Boolean(milestone.aliases?.includes(value))
  )
}
export function milestoneProgress(
  milestone: ProjectMilestone,
  rows: Array<MilestoneIssue>
) {
  const issues = rows.filter(({ issue }) =>
    matchesMilestone(milestone, issue.milestone)
  )
  const completed = issues.filter((row) => row.completed).length
  return {
    count: issues.length,
    completed,
    percent: issues.length ? Math.round((completed / issues.length) * 100) : 0,
  }
}
export function currentProjectMilestone(
  project: InitiativeProject,
  rows?: Array<MilestoneIssue>
) {
  return project.milestones?.find(
    (milestone) =>
      !milestone.completed &&
      (!rows || milestoneProgress(milestone, rows).percent < 100)
  )
}

/** Keep project copies and issue assignments together; restore exact snapshots if a write fails. */
export function relocateProjectMilestone({
  workspaceId,
  userId,
  teamIds,
  sourceId,
  milestoneId,
  targetId,
  convert = false,
}: {
  workspaceId: string
  userId: string
  teamIds: Array<string>
  sourceId: string
  milestoneId: string
  targetId?: string
  convert?: boolean
}) {
  const key = initiativesStorageKey(workspaceId)
  const stored = productStorage.getItem(key)
  if (!stored) throw new Error("Project data is unavailable.")
  let state = initiativeStoreSchema.parse(JSON.parse(stored))
  const catalog = initiativeProjectCatalog(state)
  const source = catalog.find((project) => project.id === sourceId)
  const milestone = source?.milestones?.find((item) => item.id === milestoneId)
  if (!source || !milestone)
    throw new Error("This milestone is no longer available.")
  if (targetId === sourceId) throw new Error("Choose another project.")
  const target = convert
    ? {
        id: crypto.randomUUID(),
        name: milestone.name,
        description: milestone.description,
        status: "Backlog" as const,
        health: "Update missing" as const,
        teamIds: source.teamIds,
        targetDate: milestone.targetDate,
        milestones: [],
      }
    : catalog.find((project) => project.id === targetId)
  if (targetId && !target)
    throw new Error("The destination project is unavailable.")
  const linked = (id: string) =>
    state.initiatives
      .filter((initiative) =>
        initiative.projects.some((project) => project.id === id)
      )
      .map((initiative) => initiative.id)
  const event = {
    id: crypto.randomUUID(),
    text: `${target ? (convert ? "converted" : "moved") : "deleted"} milestone ${milestone.name}${target && !convert ? ` to ${target.name}` : ""}`,
    authorId: userId,
    createdAt: new Date().toISOString(),
  }
  state = saveWorkspaceProject(
    state,
    {
      ...source,
      milestones: source.milestones?.filter((item) => item.id !== milestoneId),
      milestoneEvents: [...(source.milestoneEvents ?? []), event],
    },
    linked(source.id),
    userId
  )
  if (target)
    state = saveWorkspaceProject(
      state,
      {
        ...target,
        teamIds: [...new Set([...target.teamIds, ...source.teamIds])],
        milestones: convert ? [] : [...(target.milestones ?? []), milestone],
      },
      convert ? linked(source.id) : linked(target.id),
      userId
    )
  const snapshots = new Map<string, string | null>([[key, stored]])
  const changes = teamIds
    .map((id) => {
      const store = readIssueStore(id)
      const matching = store.issues.filter(
        (issue) =>
          matchesProject(issue, id, source) &&
          matchesMilestone(milestone, issue.milestone)
      )
      return { id, store, matching }
    })
    .filter(({ matching }) => matching.length)
  for (const { id } of changes)
    snapshots.set(teamIssuesKey(id), productStorage.getItem(teamIssuesKey(id)))
  try {
    for (const { id, store, matching } of changes) {
      const ids = new Set(matching.map((issue) => issue.id))
      writeIssueStore(id, () => ({
        ...store,
        issues: store.issues.map((issue) =>
          ids.has(issue.id)
            ? {
                ...issue,
                project: target?.id ?? issue.project,
                milestone: target && !convert ? milestone.id : "",
                updatedAt: event.createdAt,
              }
            : issue
        ),
      }))
    }
    productStorage.setItem(
      key,
      JSON.stringify(initiativeStoreSchema.parse(state))
    )
  } catch (error) {
    for (const [snapshotKey, value] of snapshots) {
      if (value === null) productStorage.removeItem(snapshotKey)
      else productStorage.setItem(snapshotKey, value)
    }
    window.dispatchEvent(new Event(ISSUES_CHANGED))
    throw error
  }
  window.dispatchEvent(new Event("forge:initiatives-changed"))
  return target
}

export function milestoneDateLabel(value?: string) {
  if (!value) return "Set target date"
  const date = parseISO(value)
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && isValid(date)
    ? format(date, "MMM d")
    : targetLabel(value)
}
