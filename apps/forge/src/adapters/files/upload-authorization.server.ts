import "@tanstack/react-start/server-only"
import { and, eq, sql } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type { UploadTarget } from "@/application/files/upload-contract"
import {
  documents,
  issues,
  projectTeams,
  projects,
  teamMembers,
  teams,
  workspaceEntitlements,
  workspaceSecuritySettings,
} from "@/db"
import { ApplicationAccessError } from "@/application/authorization"
import {
  readableDocumentCondition,
  readableIssueCondition,
  requireResourceScope,
} from "@/application/resource-policy.server"
import { readSubscriptionAccessState } from "@/application/billing/subscription-access-state.server"
import { subscriptionAccess } from "@/application/billing/subscription-access"
import { newUploadPlanAdmission } from "@/application/billing/billing-plan-contract"
import { resolveAgentFeatureFlags } from "@/application/agents/agent-feature-flags"
import { UploadError } from "@/application/files/upload-contract"

/** Hold visibility dependencies through publication, sharing FOR-39 predicates. */
export async function authorizeUploadTarget(
  tx: Transaction,
  actor: Actor,
  target: UploadTarget
) {
  if (target.kind === "agent") {
    if (!resolveAgentFeatureFlags().agent_ui)
      throw new ApplicationAccessError(
        "Forge Agent is not enabled for this deployment."
      )
    requireResourceScope(actor, "agents:write")
    return
  }
  if (
    target.kind === "document" &&
    (actor.authentication.kind !== "session" || actor.scopes !== null)
  )
    throw new ApplicationAccessError()
  if (target.kind === "issue") requireResourceScope(actor, "issues:write")
  // Lock current private-team memberships and parent visibility records before
  // checking predicates. Deletion/revocation cannot race a committed file grant.
  await tx
    .select()
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.workspaceId, actor.workspaceId),
        eq(teamMembers.userId, actor.userId)
      )
    )
    .for("share")
  if (target.kind === "document") {
    await tx
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.workspaceId, actor.workspaceId),
          eq(documents.id, target.id)
        )
      )
      .for("share")
    await tx
      .select()
      .from(projects)
      .where(
        sql`${projects.workspaceId} = ${actor.workspaceId} AND ${projects.id} IN (SELECT project_id FROM documents WHERE id = ${target.id})`
      )
      .for("share")
    await tx
      .select()
      .from(projectTeams)
      .where(
        sql`${projectTeams.workspaceId} = ${actor.workspaceId} AND ${projectTeams.projectId} IN (SELECT project_id FROM documents WHERE id = ${target.id})`
      )
      .for("share")
    await tx
      .select()
      .from(issues)
      .where(
        sql`${issues.workspaceId} = ${actor.workspaceId} AND ${issues.id} IN (SELECT issue_id FROM documents WHERE id = ${target.id})`
      )
      .for("share")
    await tx
      .select()
      .from(teams)
      .where(
        sql`${teams.workspaceId} = ${actor.workspaceId} AND ${teams.id} IN (SELECT team_id FROM documents WHERE id = ${target.id} UNION SELECT i.team_id FROM issues i JOIN documents d ON d.issue_id=i.id WHERE d.id=${target.id} UNION SELECT pt.team_id FROM project_teams pt JOIN documents d ON d.project_id=pt.project_id WHERE d.id=${target.id})`
      )
      .for("share")
    const rows = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.id, target.id),
          readableDocumentCondition(actor, documents.id)
        )
      )
      .for("share")
    if (!rows.length) throw new ApplicationAccessError()
  } else {
    await tx
      .select()
      .from(issues)
      .where(
        and(eq(issues.workspaceId, actor.workspaceId), eq(issues.id, target.id))
      )
      .for("share")
    await tx
      .select()
      .from(teams)
      .where(
        sql`${teams.workspaceId} = ${actor.workspaceId} AND ${teams.id} IN (SELECT team_id FROM issues WHERE id = ${target.id})`
      )
      .for("share")
    const rows = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(eq(issues.id, target.id), readableIssueCondition(actor, issues.id))
      )
      .for("share")
    if (!rows.length) throw new ApplicationAccessError()
  }
}

export async function assertUploadPolicy(
  tx: Transaction,
  actor: Actor,
  sizeBytes: number,
  contentType: string,
  now: Date
) {
  await tx
    .select()
    .from(workspaceEntitlements)
    .where(eq(workspaceEntitlements.workspaceId, actor.workspaceId))
    .for("share")
  const access = subscriptionAccess(
    await readSubscriptionAccessState(actor.workspaceId, tx),
    now
  )
  const plan =
    access.plan === "basic"
      ? "starter"
      : access.plan === "business"
        ? "plus"
        : access.plan
  const admission = newUploadPlanAdmission(plan, sizeBytes)
  if (!admission.allowed)
    throw new UploadError(
      "INVALID_UPLOAD",
      `Your current plan permits files up to ${admission.limitBytes} bytes (10 MB).`
    )
  await tx
    .insert(workspaceSecuritySettings)
    .values({ workspaceId: actor.workspaceId })
    .onConflictDoNothing()
  const [settings] = await tx
    .select()
    .from(workspaceSecuritySettings)
    .where(eq(workspaceSecuritySettings.workspaceId, actor.workspaceId))
    .for("share")
  if (
    settings?.restrictFileUploads &&
    !contentType.startsWith("image/") &&
    !contentType.startsWith("video/") &&
    !settings.allowedUploadTypes.includes(contentType)
  )
    throw new UploadError(
      "INVALID_UPLOAD",
      "Workspace security policy does not allow this file type."
    )
}
