import type { Actor } from "@/application/actor"
import {
  ApplicationAccessError,
  hasScope,
  hasWorkspaceRole,
} from "@/application/authorization"

export function canReadAgents(actor: Actor) {
  return hasScope(actor, "agents:read")
}

export function canRunAgents(actor: Actor) {
  return hasScope(actor, "agents:write")
}

export function canApproveAgentActions(actor: Actor) {
  return hasScope(actor, "agents:approve")
}

export function canReadModelConnections(actor: Actor) {
  return hasScope(actor, "model-connections:read")
}

export function canManagePersonalModelConnections(actor: Actor) {
  return hasScope(actor, "model-connections:write")
}

export function canManageWorkspaceModelConnections(actor: Actor) {
  return (
    hasWorkspaceRole(actor, ["owner", "admin"]) &&
    hasScope(actor, "model-connections:write")
  )
}

function requireAccess(allowed: boolean, message: string) {
  if (!allowed) {
    throw new ApplicationAccessError(message)
  }
}

export function requireAgentRead(actor: Actor) {
  requireAccess(canReadAgents(actor), "The credential cannot read agents.")
}

export function requireAgentRun(actor: Actor) {
  requireAccess(canRunAgents(actor), "The credential cannot run agents.")
}

export function requireAgentApproval(actor: Actor) {
  requireAccess(
    canApproveAgentActions(actor),
    "The credential cannot approve agent actions."
  )
}

export function requireModelConnectionRead(actor: Actor) {
  requireAccess(
    canReadModelConnections(actor),
    "The credential cannot read model connections."
  )
}

export function requirePersonalModelConnectionWrite(actor: Actor) {
  requireAccess(
    canManagePersonalModelConnections(actor),
    "The credential cannot manage personal model connections."
  )
}

export function requireWorkspaceModelConnectionWrite(actor: Actor) {
  requireAccess(
    canManageWorkspaceModelConnections(actor),
    "Only a workspace owner or admin can manage workspace model connections."
  )
}
