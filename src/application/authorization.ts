import type { Actor, ApiScope } from "@/application/actor"

export class ApplicationAccessError extends Error {
  readonly code = "FORBIDDEN"

  constructor(message = "You do not have permission to perform this action.") {
    super(message)
    this.name = "ApplicationAccessError"
  }
}

function hasWorkspaceRole(actor: Actor, allowedRoles: ReadonlyArray<string>) {
  const roles = actor.workspaceRole
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean)

  return roles.some((role) => allowedRoles.includes(role))
}

export function hasScope(actor: Actor, scope: ApiScope) {
  return actor.scopes === null || actor.scopes.includes(scope)
}

export function canReadTeams(actor: Actor) {
  return hasScope(actor, "teams:read")
}

export function canManageTeams(actor: Actor) {
  return (
    hasWorkspaceRole(actor, ["owner", "admin"]) &&
    hasScope(actor, "teams:write")
  )
}

export function requireTeamRead(actor: Actor) {
  if (!canReadTeams(actor)) {
    throw new ApplicationAccessError("The credential cannot read teams.")
  }
}
