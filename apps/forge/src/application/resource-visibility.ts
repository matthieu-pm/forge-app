import type { Actor } from "@/application/actor"
import { hasWorkspaceRole } from "@/application/authorization"

/** Resource visibility only. Adapters must also validate live membership and scopes. */
export type TeamVisibility = {
  workspaceId: string
  visibility: "workspace" | "private"
  memberUserIds: ReadonlyArray<string>
}

export type ProjectVisibility = {
  workspaceId: string
  teams: ReadonlyArray<TeamVisibility>
}

export type DocumentVisibility = {
  workspaceId: string
  /** A persisted explicit grant, never inferred from a link or backlink. */
  sharedWithWorkspace: boolean
  source:
    | { kind: "workspace" }
    | { kind: "team" | "issue"; team: TeamVisibility }
    | { kind: "project"; project: ProjectVisibility }
}

export function isTeamVisible(actor: Actor, team: TeamVisibility) {
  return (
    team.workspaceId === actor.workspaceId &&
    (team.visibility === "workspace" ||
      hasWorkspaceRole(actor, ["owner", "admin"]) ||
      team.memberUserIds.includes(actor.userId))
  )
}

export function isProjectVisible(actor: Actor, project: ProjectVisibility) {
  if (project.workspaceId !== actor.workspaceId) return false
  // Invalid cross-workspace relationships fail closed even for administrators.
  if (project.teams.some((team) => team.workspaceId !== project.workspaceId))
    return false
  return (
    !project.teams.length ||
    project.teams.some((team) => isTeamVisible(actor, team))
  )
}

export function isInitiativeVisible(actor: Actor, workspaceId: string) {
  return actor.workspaceId === workspaceId
}

export function isDocumentVisible(actor: Actor, document: DocumentVisibility) {
  if (document.workspaceId !== actor.workspaceId) return false
  const source = document.source
  if (
    source.kind === "project" &&
    (source.project.workspaceId !== document.workspaceId ||
      source.project.teams.some(
        (team) => team.workspaceId !== document.workspaceId
      ))
  )
    return false
  if (
    (source.kind === "team" || source.kind === "issue") &&
    source.team.workspaceId !== document.workspaceId
  )
    return false
  if (document.sharedWithWorkspace) return true
  switch (source.kind) {
    case "workspace":
      return true
    case "team":
    case "issue":
      return isTeamVisible(actor, source.team)
    case "project":
      return isProjectVisible(actor, source.project)
  }
}

export function canShareDocumentWithWorkspace(
  actor: Actor,
  document: DocumentVisibility
) {
  return (
    hasWorkspaceRole(actor, ["owner", "admin"]) &&
    isDocumentVisible(actor, document)
  )
}
