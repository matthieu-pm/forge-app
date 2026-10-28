import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { workspaceBillingIdentity } from "./billing-authority"
import type { Actor } from "@/application/actor"
import type { CancellationContext } from "./polar-subscription-cancellation.server"
import type { EnabledBillingConfig } from "./billing-config.server"
import { hasWorkspaceRole } from "@/application/authorization"
import { db, members, workspaceEntitlements } from "@/db"

export async function readCancellationContext(
  actor: Actor,
  environment: "sandbox" | "production"
): Promise<CancellationContext> {
  const identity = workspaceBillingIdentity(actor)
  const membership = await db.query.members.findFirst({
    where: and(
      eq(members.organizationId, identity.workspaceId),
      eq(members.userId, identity.actorUserId)
    ),
  })
  if (
    !membership ||
    !hasWorkspaceRole({ ...actor, workspaceRole: membership.role }, [
      "owner",
      "admin",
    ])
  )
    throw new Error("BILLING_ACTOR_REVOKED")
  const state = await db.query.workspaceEntitlements.findFirst({
    where: eq(workspaceEntitlements.workspaceId, identity.workspaceId),
  })
  if (state?.source !== "polar" || state.providerEnvironment !== environment)
    throw new Error("BILLING_SUBSCRIPTION_NOT_FOUND")
  return {
    workspaceId: identity.workspaceId,
    subscriptionId: z.uuid().parse(state.sourceReference),
  }
}

/** Canonical server entry point for the future authenticated billing action. */
export async function cancelWorkspaceSubscriptionAtPeriodEnd(
  actor: Actor,
  config: EnabledBillingConfig
) {
  const { PolarSubscriptionCancellation } =
    await import("./polar-subscription-cancellation.server")
  return new PolarSubscriptionCancellation(config, (candidate) =>
    readCancellationContext(candidate, config.environment)
  ).schedule(actor)
}
