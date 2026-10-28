import "@tanstack/react-start/server-only"
import { eq } from "drizzle-orm"
import { readCancellationContext } from "./subscription-cancellation-context.server"
import { subscriptionAccess } from "./subscription-access"
import { PolarPlanChanger } from "./polar-plan-change.server"
import type { WorkspacePlanChangeContext } from "./polar-plan-change.server"
import type { EnabledBillingConfig } from "./billing-config.server"
import type { SelfServePlan } from "./billing-plan-contract"
import type { Actor } from "@/application/actor"
import { db, workspaceEntitlements, workspaceMemberCapacity } from "@/db"

export async function readPlanChangeContext(
  actor: Actor,
  environment: "sandbox" | "production"
): Promise<WorkspacePlanChangeContext> {
  const binding = await readCancellationContext(actor, environment)
  const [state, capacity] = await Promise.all([
    db.query.workspaceEntitlements.findFirst({
      where: eq(workspaceEntitlements.workspaceId, binding.workspaceId),
    }),
    db.query.workspaceMemberCapacity.findFirst({
      where: eq(workspaceMemberCapacity.workspaceId, binding.workspaceId),
    }),
  ])
  const access = subscriptionAccess(state)
  if (
    !state ||
    state.source !== "polar" ||
    state.providerEnvironment !== environment ||
    state.sourceReference !== binding.subscriptionId ||
    !capacity ||
    access.phase !== "paid" ||
    !["basic", "business"].includes(access.plan)
  )
    throw new Error("BILLING_PAID_PLAN_REQUIRED")
  return {
    ...binding,
    billableMembers: capacity.activeMemberCount,
    projectedPlan: access.plan === "basic" ? "starter" : "plus",
  }
}

/** Server entry for a future authenticated billing action; public billing stays gated. */
export async function changeWorkspacePlan(
  actor: Actor,
  target: SelfServePlan,
  config: EnabledBillingConfig
) {
  return new PolarPlanChanger(config, (candidate) =>
    readPlanChangeContext(candidate, config.environment)
  ).change(actor, target)
}
