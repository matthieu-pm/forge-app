import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { workspaceBillingIdentity } from "./billing-authority"
import { STANDARD_PLAN_TRIAL_DAYS } from "./billing-plan-contract"
import type { Actor } from "@/application/actor"
import { hasWorkspaceRole } from "@/application/authorization"
import {
  db,
  members,
  organizations,
  users,
  workspaceEntitlements,
  workspaceSecurityAuditEvents,
  workspaceTrialRedemptions,
} from "@/db"

export const startTrialInput = z.strictObject({
  requestId: z.uuid(),
  plan: z.enum(["starter", "plus"]),
})

/** Internal command. Public exposure must wait for atomic usage admission. */
export async function startWorkspaceTrial(actor: Actor, value: unknown) {
  const identity = workspaceBillingIdentity(actor)
  const input = startTrialInput.parse(value)
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: identity.workspaceId,
        actorUserId: identity.actorUserId,
        ...input,
      })
    )
    .digest("hex")
  return db.transaction(async (tx) => {
    const workspace = (
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, identity.workspaceId))
        .for("no key update")
    ).at(0)
    if (!workspace) throw new Error("TRIAL_WORKSPACE_NOT_FOUND")
    const member = (
      await tx
        .select({ role: members.role })
        .from(members)
        .where(
          and(
            eq(members.organizationId, identity.workspaceId),
            eq(members.userId, identity.actorUserId)
          )
        )
        .for("share")
    ).at(0)
    const user = (
      await tx
        .select({ verified: users.emailVerified })
        .from(users)
        .where(eq(users.id, identity.actorUserId))
        .for("share")
    ).at(0)
    if (
      !member ||
      !hasWorkspaceRole({ ...actor, workspaceRole: member.role }, [
        "owner",
        "admin",
      ])
    )
      throw new Error("TRIAL_ACTOR_REVOKED")
    if (!user?.verified) throw new Error("TRIAL_EMAIL_VERIFICATION_REQUIRED")
    const prior = await tx.query.workspaceTrialRedemptions.findFirst({
      where: eq(workspaceTrialRedemptions.workspaceId, identity.workspaceId),
    })
    if (prior) {
      if (
        prior.startRequestId === input.requestId &&
        prior.startBodyHash !== hash
      )
        throw new Error("TRIAL_REQUEST_CONFLICT")
      if (prior.initialPlan !== input.plan) throw new Error("TRIAL_TIER_LOCKED")
      return { trial: prior, replayed: true }
    }
    const state = await tx.query.workspaceEntitlements.findFirst({
      where: eq(workspaceEntitlements.workspaceId, identity.workspaceId),
    })
    // Retain paid history in the single projection. Unknown/manual/provider
    // states require reconciliation rather than interpreting them as eligible.
    if (
      state &&
      (state.source !== "internal" ||
        state.plan !== "free" ||
        state.status !== "active" ||
        state.sourceReference ||
        state.paidActivatedAt ||
        state.refundedPeriods.length ||
        state.providerEnvironment ||
        state.terminatedAt ||
        state.trialRedemptionId)
    )
      throw new Error("TRIAL_NEVER_PAID_REQUIRED")
    const startedAt = new Date()
    const expiresAt = new Date(
      startedAt.getTime() + STANDARD_PLAN_TRIAL_DAYS * 86400000
    )
    const [trial] = await tx
      .insert(workspaceTrialRedemptions)
      .values({
        workspaceId: identity.workspaceId,
        initialPlan: input.plan,
        actorUserId: identity.actorUserId,
        startRequestId: input.requestId,
        startBodyHash: hash,
        startedAt,
        expiresAt,
      })
      .returning()
    const projection = {
      plan: input.plan === "starter" ? "basic" : "business",
      status: "trialing",
      source: "forge-trial",
      sourceReference: trial.id,
      trialRedemptionId: trial.id,
      currentPeriodStart: startedAt,
      currentPeriodEnd: expiresAt,
      updatedAt: startedAt,
      featureOverrides: {},
    }
    await tx
      .insert(workspaceEntitlements)
      .values({ workspaceId: identity.workspaceId, ...projection })
      .onConflictDoUpdate({
        target: workspaceEntitlements.workspaceId,
        set: projection,
      })
    await tx.insert(workspaceSecurityAuditEvents).values({
      workspaceId: identity.workspaceId,
      actorUserId: identity.actorUserId,
      action: "billing.trial.started",
      target: trial.id,
      outcome: "succeeded",
      requestId: `forge.trial-start.${input.requestId}`,
      after: {
        plan: trial.initialPlan,
        startedAt: startedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        allowanceUsdMicros: 5_000_000,
      },
    })
    return { trial, replayed: false }
  })
}

/** Cleanup only; read-time access expiry does not depend on this worker. */
export async function expireWorkspaceTrial(workspaceId: string) {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, workspaceId))
      .for("no key update")
    const trial = await tx.query.workspaceTrialRedemptions.findFirst({
      where: eq(workspaceTrialRedemptions.workspaceId, workspaceId),
    })
    if (!trial || trial.expiresAt.getTime() > Date.now())
      return { expired: false }
    const changed = (
      await tx
        .update(workspaceEntitlements)
        .set({ plan: "free", status: "canceled", updatedAt: new Date() })
        .where(
          and(
            eq(workspaceEntitlements.workspaceId, workspaceId),
            eq(workspaceEntitlements.source, "forge-trial"),
            eq(workspaceEntitlements.trialRedemptionId, trial.id),
            eq(workspaceEntitlements.status, "trialing")
          )
        )
        .returning({ id: workspaceEntitlements.workspaceId })
    ).at(0)
    if (!changed) return { expired: false }
    await tx.insert(workspaceSecurityAuditEvents).values({
      workspaceId,
      actorUserId: null,
      action: "billing.trial.expired",
      target: trial.id,
      outcome: "succeeded",
      requestId: `forge.trial-expiry.${trial.id}`,
      after: {
        plan: "free",
        originalExpiresAt: trial.expiresAt.toISOString(),
        grantsNewAllowance: false,
      },
    })
    return { expired: true }
  })
}
