import "@tanstack/react-start/server-only"
import type { Actor } from "@/application/actor"
import type { CapabilityInvocation } from "@/application/agents/capability-contract"
import {
  ApplicationAccessError,
  canManageTeams,
} from "@/application/authorization"
import {
  requireCurrentActor,
  requireResourceScope,
} from "@/application/resource-policy.server"
import { getTeam } from "@/application/teams/teams.server"

/** Called before approvals, receipt lookup and execution, including all reads. */
export async function authorizeForgeCapability(
  actor: Actor,
  invocation: CapabilityInvocation
) {
  actor = await requireCurrentActor(actor)
  switch (invocation.capabilityId) {
    case "teams.list":
    case "teams.get":
    case "workspace.describe":
      requireResourceScope(actor, "teams:read")
      break
    case "teams.update": {
      requireResourceScope(actor, "teams:read")
      if (
        !canManageTeams(actor) ||
        typeof invocation.input.slug !== "string" ||
        !(await getTeam(actor, { slug: invocation.input.slug }))
      )
        throw new ApplicationAccessError()
      break
    }
    case "artifacts.create":
      requireResourceScope(actor, "agents:write")
      break
    default:
      throw new ApplicationAccessError()
  }
  return actor
}
