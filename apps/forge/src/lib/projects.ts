import {
  initiativePriorities,
  patchInitiative,
  targetTimestamp,
} from "./initiatives"
import { saveInitiativeProject } from "./initiative-projects"
import type { InitiativeProject, InitiativeStore } from "./initiatives"
import type { ProjectFilter, ProjectPreferences } from "./project-view-contract"

export * from "./project-view-contract"
export const projectPreferencesKey = (
  workspaceId: string,
  userId: string,
  teamId?: string
) =>
  `forge:workspace:${workspaceId}:projects-view:v1:${userId}:${teamId ?? "all"}`
export function projectValues(
  project: InitiativeProject,
  field: string,
  state: InitiativeStore
): Array<string> {
  switch (field) {
    case "Status":
      return [project.status]
    case "Priority":
      return [project.priority ?? "No priority"]
    case "Health":
      return [project.health]
    case "Teams":
      return project.teamIds.length ? project.teamIds : [""]
    case "Lead":
    case "Leads":
      return [project.leadId ?? ""]
    case "Members":
      return project.memberIds ?? []
    case "Labels":
      return project.labelIds ?? []
    case "Target date":
      return [project.targetDate ?? ""]
    case "Specific project":
      return [project.id]
    case "Initiatives": {
      const ids = state.initiatives
        .filter((item) =>
          item.projects.some((value) => value.id === project.id)
        )
        .map((item) => item.id)
      return ids.length ? ids : [""]
    }
    default:
      return []
  }
}
export function visibleProjects(
  catalog: Array<InitiativeProject>,
  state: InitiativeStore,
  filters: Array<ProjectFilter>,
  preferences: ProjectPreferences,
  teamId?: string
) {
  const items = catalog.filter((project) => {
    if (teamId && !project.teamIds.includes(teamId)) return false
    const closed =
      project.status === "Completed" || project.status === "Canceled"
    if (
      (preferences.closed === "Hide" && closed) ||
      (preferences.closed === "Only" && !closed)
    )
      return false
    return filters.every(({ field, value }) =>
      field === "Title & summary"
        ? `${project.name} ${project.summary ?? ""}`
            .toLowerCase()
            .includes(value.toLowerCase())
        : projectValues(project, field, state).includes(value)
    )
  })
  return items.sort((a, b) => {
    let result = 0
    switch (preferences.ordering) {
      case "Name":
        result = a.name.localeCompare(b.name)
        break
      case "Priority":
        result =
          (initiativePriorities.indexOf(a.priority ?? "No priority") || 5) -
          (initiativePriorities.indexOf(b.priority ?? "No priority") || 5)
        break
      case "Status":
        result = a.status.localeCompare(b.status)
        break
      case "Health":
        result = a.health.localeCompare(b.health)
        break
      case "Target date": {
        const av = a.targetDate ? targetTimestamp(a.targetDate) : Infinity
        const bv = b.targetDate ? targetTimestamp(b.targetDate) : Infinity
        result = av === bv ? 0 : av - bv
        break
      }
      case "Created":
      case "Updated": {
        const field =
          preferences.ordering === "Created" ? "createdAt" : "updatedAt"
        result = (a[field] ?? "").localeCompare(b[field] ?? "")
        break
      }
    }
    return preferences.descending ? -result : result
  })
}

// Save one canonical project, synchronizing the copies attached to initiatives.
export function saveWorkspaceProject(
  state: InitiativeStore,
  project: InitiativeProject,
  initiativeIds: Array<string>,
  userId: string,
  now = new Date().toISOString()
) {
  const previous =
    state.workspaceProjects.find((value) => value.id === project.id) ??
    state.initiatives
      .flatMap((value) => value.projects)
      .find((value) => value.id === project.id)
  const nextProject = {
    ...project,
    creatorId: previous?.creatorId ?? userId,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
  const next = saveInitiativeProject(state, "", nextProject)
  return {
    ...next,
    initiatives: next.initiatives.map((item) => {
      const linked = item.projects.some((value) => value.id === project.id)
      const wanted = initiativeIds.includes(item.id)
      if (linked === wanted) return item
      return patchInitiative(item, {
        projects: wanted
          ? [...item.projects, nextProject]
          : item.projects.filter((value) => value.id !== project.id),
      })
    }),
  }
}
