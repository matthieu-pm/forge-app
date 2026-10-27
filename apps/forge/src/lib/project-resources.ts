import { initiativeProjectCatalog } from "./initiative-projects"
import { initiativeProjectSchema } from "./initiatives"
import { saveWorkspaceProject } from "./projects"
import { defaultDocumentIcon } from "./team-documents"
import type { Initiative, InitiativeStore } from "./initiatives"

export type ProjectResource = Initiative["resources"][number]

export function newResourceDocument(): ProjectResource {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    title: "New document",
    body: { type: "doc", content: [{ type: "paragraph" }] },
    icon: defaultDocumentIcon,
    createdAt: now,
    updatedAt: now,
  }
}

export function updateProjectResources(
  state: InitiativeStore,
  projectId: string,
  update: (resources: Array<ProjectResource>) => Array<ProjectResource>,
  userId: string
) {
  const project = initiativeProjectCatalog(state).find(
    (item) => item.id === projectId
  )
  if (!project) throw new Error("Project removed")
  return saveWorkspaceProject(
    state,
    initiativeProjectSchema.parse({
      ...project,
      resources: update(project.resources ?? []),
    }),
    state.initiatives
      .filter((item) => item.projects.some((value) => value.id === projectId))
      .map((item) => item.id),
    userId
  )
}
