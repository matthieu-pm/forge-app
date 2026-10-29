import { and, eq, inArray, isNull, lte } from "drizzle-orm"
import { FatalError, RetryableError } from "workflow"
import { emitTelemetry } from "../../../../packages/telemetry/server"

import { sendWorkspaceInvitationEmail } from "@/application/mail/auth-emails.server"
import { EmailDeliveryError } from "@/application/mail/mail.server"
import {
  classifyInvitationDelivery,
  invitationEffectKey,
} from "@/application/workflows/invitation-delivery-policy"
import {
  businessWorkflowEffects,
  businessWorkflowRuns,
  db,
  invitations,
  organizations,
  users,
} from "@/db"

async function loadInvitationForRun(businessRunId: string) {
  const [record] = await db
    .select({
      runId: businessWorkflowRuns.id,
      invitationId: invitations.id,
      email: invitations.email,
      role: invitations.role,
      status: invitations.status,
      expiresAt: invitations.expiresAt,
      organizationName: organizations.name,
      inviterName: users.name,
      inviterEmail: users.email,
    })
    .from(businessWorkflowRuns)
    .innerJoin(
      invitations,
      and(
        eq(businessWorkflowRuns.subjectType, "invitation"),
        eq(businessWorkflowRuns.subjectId, invitations.id)
      )
    )
    .innerJoin(organizations, eq(invitations.organizationId, organizations.id))
    .innerJoin(users, eq(invitations.inviterId, users.id))
    .where(eq(businessWorkflowRuns.id, businessRunId))
    .limit(1)

  return record
}

export async function claimInvitationRunStep(
  businessRunId: string,
  sdkRunId: string
) {
  "use step"

  const now = new Date()
  await db
    .update(businessWorkflowRuns)
    .set({
      sdkRunId,
      state: "running",
      startedAt: now,
      failureCode: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(businessWorkflowRuns.id, businessRunId),
        isNull(businessWorkflowRuns.sdkRunId),
        inArray(businessWorkflowRuns.state, [
          "queued",
          "starting",
          "failed-to-start",
        ])
      )
    )

  const [run] = await db
    .select({
      sdkRunId: businessWorkflowRuns.sdkRunId,
      createdAt: businessWorkflowRuns.createdAt,
    })
    .from(businessWorkflowRuns)
    .where(eq(businessWorkflowRuns.id, businessRunId))
    .limit(1)

  const claimed = run?.sdkRunId === sdkRunId
  emitTelemetry(
    claimed ? "operation.completed" : "operation.rejected",
    "invitation.claim",
    {
      businessRunId,
      correlationId: businessRunId,
      ...(run
        ? { queueAgeMs: Math.max(0, now.getTime() - run.createdAt.getTime()) }
        : {}),
    }
  )
  return claimed
}

export async function sendInvitationEffectStep(
  businessRunId: string,
  effect: "initial" | "reminder-24h"
) {
  "use step"

  const invitation = await loadInvitationForRun(businessRunId)
  if (!invitation) {
    throw new FatalError("The invitation workflow subject is missing.")
  }
  const deliveryState = classifyInvitationDelivery({
    effect,
    expiresAt: invitation.expiresAt,
    now: new Date(),
    status: invitation.status,
  })
  if (deliveryState === "not-pending") {
    return {
      state: "not-pending",
      expiresAt: new Date().toISOString(),
    } as const
  }

  if (deliveryState === "expired") {
    await db
      .update(invitations)
      .set({ status: "expired" })
      .where(
        and(
          eq(invitations.id, invitation.invitationId),
          eq(invitations.status, "pending")
        )
      )
    return {
      state: "expired",
      expiresAt: invitation.expiresAt.toISOString(),
    } as const
  }
  if (deliveryState === "too-close-to-expiry") {
    return {
      state: "too-close-to-expiry",
      expiresAt: invitation.expiresAt.toISOString(),
    } as const
  }

  const effectKey = invitationEffectKey(invitation.invitationId, effect)
  const [existingEffect] = await db
    .select({
      id: businessWorkflowEffects.id,
      state: businessWorkflowEffects.state,
      providerReference: businessWorkflowEffects.providerReference,
    })
    .from(businessWorkflowEffects)
    .where(
      and(
        eq(businessWorkflowEffects.businessRunId, businessRunId),
        eq(businessWorkflowEffects.effectKey, effectKey)
      )
    )
    .limit(1)

  if (existingEffect?.state === "completed") {
    return {
      state: "delivered",
      expiresAt: invitation.expiresAt.toISOString(),
    } as const
  }

  const [effectRecord] = existingEffect
    ? [existingEffect]
    : await db
        .insert(businessWorkflowEffects)
        .values({
          businessRunId,
          effectKey,
          state: "pending",
        })
        .onConflictDoNothing()
        .returning({
          id: businessWorkflowEffects.id,
          state: businessWorkflowEffects.state,
          providerReference: businessWorkflowEffects.providerReference,
        })

  const effectId =
    effectRecord?.id ??
    (
      await db
        .select({ id: businessWorkflowEffects.id })
        .from(businessWorkflowEffects)
        .where(
          and(
            eq(businessWorkflowEffects.businessRunId, businessRunId),
            eq(businessWorkflowEffects.effectKey, effectKey)
          )
        )
        .limit(1)
    )[0]?.id

  if (!effectId) {
    throw new Error("The workflow effect could not be reserved.")
  }

  await db
    .update(businessWorkflowEffects)
    .set({
      state: "sending",
      failureCode: null,
      updatedAt: new Date(),
    })
    .where(eq(businessWorkflowEffects.id, effectId))

  try {
    const delivery = await sendWorkspaceInvitationEmail({
      id: invitation.invitationId,
      email: invitation.email,
      role: invitation.role ?? "member",
      organizationName: invitation.organizationName,
      inviterName: invitation.inviterName || invitation.inviterEmail,
      inviterEmail: invitation.inviterEmail,
      appUrl: process.env.BETTER_AUTH_URL ?? "",
      idempotencyKey: effectKey,
      reminder: effect === "reminder-24h",
    })

    await db
      .update(businessWorkflowEffects)
      .set({
        state: "completed",
        providerReference: delivery.id,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(businessWorkflowEffects.id, effectId))
  } catch (error) {
    emitTelemetry("operation.failed", "invitation.deliver", {
      businessRunId,
      correlationId: businessRunId,
      errorCode: "EMAIL_DELIVERY_FAILED",
    })
    await db
      .update(businessWorkflowEffects)
      .set({
        state: "failed",
        failureCode: "email_provider_error",
        updatedAt: new Date(),
      })
      .where(eq(businessWorkflowEffects.id, effectId))
    if (error instanceof EmailDeliveryError) {
      if (!error.retryable) {
        throw new FatalError("The email provider rejected the invitation.")
      }
      throw new RetryableError(
        "The email provider is temporarily unavailable.",
        {
          retryAfter: error.statusCode === 429 ? "1m" : "5s",
        }
      )
    }
    throw new RetryableError("The invitation delivery failed.", {
      retryAfter: "5s",
    })
  }

  emitTelemetry("operation.completed", "invitation.deliver", {
    businessRunId,
    correlationId: businessRunId,
  })
  return {
    state: "delivered",
    expiresAt: invitation.expiresAt.toISOString(),
  } as const
}

export async function expireInvitationStep(businessRunId: string) {
  "use step"

  const invitation = await loadInvitationForRun(businessRunId)
  if (!invitation) return

  await db
    .update(invitations)
    .set({ status: "expired" })
    .where(
      and(
        eq(invitations.id, invitation.invitationId),
        eq(invitations.status, "pending"),
        lte(invitations.expiresAt, new Date())
      )
    )
}

export async function completeInvitationRunStep(businessRunId: string) {
  "use step"

  const now = new Date()
  await db
    .update(businessWorkflowRuns)
    .set({
      state: "completed",
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(businessWorkflowRuns.id, businessRunId))
}

export async function failInvitationRunStep(businessRunId: string) {
  "use step"

  emitTelemetry("operation.failed", "invitation.fail", {
    businessRunId,
    correlationId: businessRunId,
    errorCode: "WORKFLOW_EXECUTION_FAILED",
  })

  await db
    .update(businessWorkflowRuns)
    .set({
      state: "failed",
      failureCode: "workflow_execution_failed",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(businessWorkflowRuns.id, businessRunId))
}
