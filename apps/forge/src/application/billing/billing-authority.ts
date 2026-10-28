import type { Actor } from "@/application/actor"
import {
  ApplicationAccessError,
  hasWorkspaceRole,
} from "@/application/authorization"

/** No client-supplied customer, workspace, amount or seat quantity is accepted. */
export function workspaceBillingIdentity(actor: Actor) {
  if (
    actor.authentication.kind !== "session" ||
    !hasWorkspaceRole(actor, ["owner", "admin"]) ||
    !actor.workspaceId.trim() ||
    !actor.userId.trim()
  ) {
    throw new ApplicationAccessError(
      "An authenticated workspace owner or admin must manage billing."
    )
  }
  return {
    externalCustomerId: `forge:workspace:${actor.workspaceId}`,
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId,
  }
}
