import { patchInitiative } from "./initiatives"
import type { InitiativeProject, InitiativeStore } from "./initiatives"

export function initiativeProjectCatalog(
  state: InitiativeStore
): Array<InitiativeProject> {
  const projects = new Map<string, InitiativeProject>()
  for (const item of state.initiatives)
    for (const project of item.projects) projects.set(project.id, project)
  for (const project of state.workspaceProjects)
    projects.set(project.id, project)
  return [...projects.values()]
}

// One project may contribute to several initiatives. Keep their displayed records in sync.
export function saveInitiativeProject(
  state: InitiativeStore,
  initiativeId: string,
  project: InitiativeProject
): InitiativeStore {
  return {
    ...state,
    workspaceProjects: [
      ...initiativeProjectCatalog(state).filter(
        (value) => value.id !== project.id
      ),
      project,
    ],
    initiatives: state.initiatives.map((item) => {
      const linked = item.projects.some((value) => value.id === project.id)
      if (!linked && item.id !== initiativeId) return item
      return patchInitiative(item, {
        projects: linked
          ? item.projects.map((value) =>
              value.id === project.id ? project : value
            )
          : [...item.projects, project],
      })
    }),
  }
}

export function projectDependencyCycle(
  project: InitiativeProject,
  catalog: Array<InitiativeProject>
): boolean {
  const all = new Map(catalog.map((value) => [value.id, value]))
  all.set(project.id, project)
  function visit(id: string, path: Set<string>): boolean {
    if (path.has(id)) return true
    const next = new Set(path).add(id)
    return (all.get(id)?.dependencyIds ?? []).some((value) =>
      visit(value, next)
    )
  }
  return visit(project.id, new Set())
}
