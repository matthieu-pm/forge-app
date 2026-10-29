import "@tanstack/react-start/server-only"

import { randomBytes } from "node:crypto"
import { resolveTxt } from "node:dns/promises"
import { domainToASCII } from "node:url"

import { and, asc, eq } from "drizzle-orm"

import type { Actor } from "@/application/actor"
import type {
  SecurityBooleanSetting,
  SecurityPolicySetting,
  WorkspacePlan,
  WorkspaceSecurityAction,
  WorkspaceSecurityCommand,
  WorkspaceSecurityFeature,
  WorkspaceSecurityMutationResult,
  WorkspaceSecuritySettings,
  WorkspaceSecuritySnapshot,
} from "@/application/workspace-security/security-contract"
import type { DatabaseExecutor } from "@/db"
import { hasWorkspaceRole } from "@/application/authorization"
import { subscriptionAccess } from "@/application/billing/subscription-access"
import { readSubscriptionAccessState } from "@/application/billing/subscription-access-state.server"
import {
  REQUIRED_PLAN,
  isWorkspaceActionAllowed,
  resolveEntitlements,
} from "@/application/workspace-security/security-policy"
import { signWorkspaceInviteLink } from "@/application/workspace-security/invite-link-token.server"
import {
  db,
  organizations,
  workspaceApprovedDomains,
  workspaceSecurityAuditEvents,
  workspaceSecuritySettings,
} from "@/db"

type SecurityRow = typeof workspaceSecuritySettings.$inferSelect

const BOOLEAN_SETTING_FEATURE: Partial<
  Record<SecurityBooleanSetting, WorkspaceSecurityFeature>
> = {
  restrictFileUploads: "file-upload-restrictions",
  reviewThirdPartyApplications: "application-approvals",
  reduceSupportPii: "support-pii-reduction",
  blockGuestAgentAccess: "restrict-guest-agents",
  hipaaEnabled: "hipaa",
}

const POLICY_SETTING_FEATURE: Partial<
  Record<SecurityPolicySetting, WorkspaceSecurityFeature>
> = {
  invitationPolicy: "restrict-invitations",
  teamCreationPolicy: "team-creation-policy",
  workspaceLabelsPolicy: "workspace-label-policy",
  workspaceTemplatesPolicy: "workspace-template-policy",
  loopsPolicy: "loop-management-policy",
}

export class WorkspaceSecurityAccessError extends Error {
  constructor(
    readonly code: "FORBIDDEN" | "PLAN_REQUIRED",
    message: string,
    readonly requiredPlan?: WorkspacePlan
  ) {
    super(message)
    this.name = "WorkspaceSecurityAccessError"
  }
}

function toSettings(row: SecurityRow): WorkspaceSecuritySettings {
  return {
    inviteLinksEnabled: row.inviteLinksEnabled,
    googleAuthenticationEnabled: row.googleAuthenticationEnabled,
    emailPasskeyAuthenticationEnabled: row.emailPasskeyAuthenticationEnabled,
    invitationPolicy:
      row.invitationPolicy as WorkspaceSecuritySettings["invitationPolicy"],
    teamCreationPolicy:
      row.teamCreationPolicy as WorkspaceSecuritySettings["teamCreationPolicy"],
    workspaceLabelsPolicy:
      row.workspaceLabelsPolicy as WorkspaceSecuritySettings["workspaceLabelsPolicy"],
    workspaceTemplatesPolicy:
      row.workspaceTemplatesPolicy as WorkspaceSecuritySettings["workspaceTemplatesPolicy"],
    loopsPolicy: row.loopsPolicy as WorkspaceSecuritySettings["loopsPolicy"],
    apiKeyCreationPolicy:
      row.apiKeyCreationPolicy as WorkspaceSecuritySettings["apiKeyCreationPolicy"],
    agentGuidancePolicy:
      row.agentGuidancePolicy as WorkspaceSecuritySettings["agentGuidancePolicy"],
    restrictFileUploads: row.restrictFileUploads,
    allowedUploadTypes: Array.isArray(row.allowedUploadTypes)
      ? row.allowedUploadTypes.filter(
          (value): value is string => typeof value === "string"
        )
      : [],
    reviewThirdPartyApplications: row.reviewThirdPartyApplications,
    reduceSupportPii: row.reduceSupportPii,
    blockGuestAgentAccess: row.blockGuestAgentAccess,
    shareAiUsageData: row.shareAiUsageData,
    agentWebSearchEnabled: row.agentWebSearchEnabled,
    externalLoopSourcesEnabled: row.externalLoopSourcesEnabled,
    mcpServersEnabled: row.mcpServersEnabled,
    hipaaEnabled: row.hipaaEnabled,
  }
}

async function ensureSecurityRow(
  workspaceId: string,
  executor: DatabaseExecutor = db
) {
  await executor
    .insert(workspaceSecuritySettings)
    .values({ workspaceId })
    .onConflictDoNothing()

  const row = await executor.query.workspaceSecuritySettings.findFirst({
    where: eq(workspaceSecuritySettings.workspaceId, workspaceId),
  })
  if (!row) throw new Error("Workspace security settings could not be loaded.")
  return row
}

async function entitlementState(workspaceId: string) {
  const row = await readSubscriptionAccessState(workspaceId)
  const { plan } = subscriptionAccess(row)
  const overrides =
    (row?.source !== "polar" || plan !== "free") &&
    row?.featureOverrides &&
    typeof row.featureOverrides === "object" &&
    !Array.isArray(row.featureOverrides)
      ? row.featureOverrides
      : {}

  return { plan, entitlements: resolveEntitlements(plan, overrides) }
}

async function buildSnapshot(
  actor: Actor,
  requestUrl: string
): Promise<WorkspaceSecuritySnapshot> {
  const [row, workspaceRows, domains, access] = await Promise.all([
    ensureSecurityRow(actor.workspaceId),
    db
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
      })
      .from(organizations)
      .where(eq(organizations.id, actor.workspaceId))
      .limit(1),
    db
      .select()
      .from(workspaceApprovedDomains)
      .where(eq(workspaceApprovedDomains.workspaceId, actor.workspaceId))
      .orderBy(asc(workspaceApprovedDomains.domain)),
    entitlementState(actor.workspaceId),
  ])
  const workspace = workspaceRows.at(0)
  if (!workspace) throw new Error("The workspace was not found.")

  const token = row.inviteLinksEnabled
    ? await signWorkspaceInviteLink({
        workspaceId: actor.workspaceId,
        generation: row.inviteLinkVersion,
      })
    : null

  return {
    workspace,
    version: row.version,
    canManage: hasWorkspaceRole(actor, ["owner", "admin"]),
    plan: access.plan,
    entitlements: access.entitlements,
    settings: toSettings(row),
    inviteLink: token
      ? new URL(`/join/${encodeURIComponent(token)}`, requestUrl).toString()
      : null,
    domains: domains.map((domain) => ({
      id: domain.id,
      domain: domain.domain,
      source: domain.source as "manual" | "sso",
      verifiedAt: domain.verifiedAt?.toISOString() ?? null,
      verificationCode: domain.verificationCode,
      verificationExpiresAt:
        domain.verificationExpiresAt?.toISOString() ?? null,
      createdAt: domain.createdAt.toISOString(),
    })),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function getWorkspaceSecuritySnapshot(
  actor: Actor,
  requestUrl: string
) {
  if (!hasWorkspaceRole(actor, ["owner", "admin"])) {
    throw new WorkspaceSecurityAccessError(
      "FORBIDDEN",
      "Only workspace owners and administrators can view security settings."
    )
  }
  return buildSnapshot(actor, requestUrl)
}

function normalizedDomain(value: string) {
  const candidate = value.trim().toLowerCase().replace(/\.$/, "")
  if (
    !candidate ||
    candidate.includes("/") ||
    candidate.includes("@") ||
    candidate.includes(":")
  ) {
    return null
  }
  const ascii = domainToASCII(candidate)
  if (
    !ascii ||
    ascii.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
      ascii
    )
  ) {
    return null
  }
  return ascii
}

function constraintName(error: unknown) {
  const values: Array<string> = []
  let candidate = error
  const visited = new Set<object>()

  while (
    candidate &&
    typeof candidate === "object" &&
    !visited.has(candidate)
  ) {
    visited.add(candidate)
    const current = candidate as {
      cause?: unknown
      constraint?: unknown
      message?: unknown
    }
    if (typeof current.constraint === "string") {
      values.push(current.constraint)
    }
    if (typeof current.message === "string") values.push(current.message)
    candidate = current.cause
  }
  return values.join(" ")
}

function requiredFeature(command: WorkspaceSecurityCommand) {
  if (command.type === "set-boolean" && command.value) {
    return BOOLEAN_SETTING_FEATURE[command.key]
  }
  if (command.type === "set-policy" && command.value === "admins") {
    return POLICY_SETTING_FEATURE[command.key]
  }
  return undefined
}

async function writeRejectedAudit(
  actor: Actor,
  command: WorkspaceSecurityCommand,
  requestId?: string
) {
  const target =
    command.type === "set-boolean" || command.type === "set-policy"
      ? command.key
      : command.type === "remove-domain" || command.type === "verify-domain"
        ? command.domainId
        : command.type === "add-domain"
          ? normalizedDomain(command.domain)
          : null
  await db.insert(workspaceSecurityAuditEvents).values({
    workspaceId: actor.workspaceId,
    actorUserId: actor.userId,
    action: `security.${command.type}.rejected`,
    target,
    outcome: "rejected",
    before: null,
    after: null,
    requestId,
  })
}

function auditValues(
  command: WorkspaceSecurityCommand,
  before: SecurityRow
): {
  action: string
  target: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
} {
  if (command.type === "set-boolean" || command.type === "set-policy") {
    return {
      action: "security.setting.updated",
      target: command.key,
      before: { value: before[command.key] },
      after: { value: command.value },
    }
  }
  if (command.type === "reset-invite-link") {
    return {
      action: "security.invite-link.reset",
      target: null,
      before: { generation: before.inviteLinkVersion },
      after: { generation: before.inviteLinkVersion + 1 },
    }
  }
  if (command.type === "add-domain") {
    return {
      action: "security.approved-domain.added",
      target: normalizedDomain(command.domain),
      before: null,
      after: { source: "manual", verified: false },
    }
  }
  if (command.type === "verify-domain") {
    return {
      action: "security.approved-domain.verified",
      target: command.domainId,
      before: { verified: false },
      after: { verified: true },
    }
  }
  return {
    action: "security.approved-domain.removed",
    target: command.domainId,
    before: null,
    after: null,
  }
}

async function verifyDomainDnsRecord(
  actor: Actor,
  command: Extract<WorkspaceSecurityCommand, { type: "verify-domain" }>
) {
  const rows = await db
    .select({
      domain: workspaceApprovedDomains.domain,
      verificationCode: workspaceApprovedDomains.verificationCode,
      verificationExpiresAt: workspaceApprovedDomains.verificationExpiresAt,
      verifiedAt: workspaceApprovedDomains.verifiedAt,
    })
    .from(workspaceApprovedDomains)
    .where(
      and(
        eq(workspaceApprovedDomains.id, command.domainId),
        eq(workspaceApprovedDomains.workspaceId, actor.workspaceId)
      )
    )
    .limit(1)
  const domain = rows.at(0)
  if (!domain) {
    return {
      ok: false as const,
      code: "NOT_FOUND" as const,
      message: "The approved domain no longer exists.",
    }
  }
  if (domain.verifiedAt) {
    return {
      ok: false as const,
      code: "VALIDATION_FAILED" as const,
      message: "This domain is already verified.",
    }
  }
  if (
    !domain.verificationCode ||
    !domain.verificationExpiresAt ||
    domain.verificationExpiresAt <= new Date()
  ) {
    return {
      ok: false as const,
      code: "VALIDATION_FAILED" as const,
      message:
        "This verification code expired. Remove the domain and add it again.",
    }
  }

  try {
    const records = await Promise.race([
      resolveTxt(domain.domain),
      new Promise<never>((_, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Domain verification timed out.")),
          5_000
        )
        timeout.unref()
      }),
    ])
    if (
      !records.some((record) => record.join("") === domain.verificationCode)
    ) {
      return {
        ok: false as const,
        code: "VALIDATION_FAILED" as const,
        message: "The required DNS TXT record was not found.",
      }
    }
  } catch {
    return {
      ok: false as const,
      code: "VALIDATION_FAILED" as const,
      message: "The required DNS TXT record could not be verified.",
    }
  }

  return {
    ok: true as const,
    verificationCode: domain.verificationCode,
  }
}

export async function executeWorkspaceSecurityCommand(
  actor: Actor,
  command: WorkspaceSecurityCommand,
  requestUrl: string,
  requestId?: string
): Promise<WorkspaceSecurityMutationResult> {
  if (!hasWorkspaceRole(actor, ["owner", "admin"])) {
    await writeRejectedAudit(actor, command, requestId)
    return {
      ok: false,
      code: "FORBIDDEN",
      message:
        "Only workspace owners and administrators can change security settings.",
    }
  }

  const access = await entitlementState(actor.workspaceId)
  const feature = requiredFeature(command)
  if (feature && !access.entitlements[feature]) {
    await writeRejectedAudit(actor, command, requestId)
    const requiredPlan = REQUIRED_PLAN[feature]
    return {
      ok: false,
      code: "PLAN_REQUIRED",
      message: `The ${requiredPlan} plan is required for this setting.`,
      requiredPlan,
    }
  }

  if (command.type === "add-domain" && !normalizedDomain(command.domain)) {
    await writeRejectedAudit(actor, command, requestId)
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Enter a valid email domain, such as example.com.",
    }
  }

  const domainVerification =
    command.type === "verify-domain"
      ? await verifyDomainDnsRecord(actor, command)
      : null
  if (domainVerification && !domainVerification.ok) {
    await writeRejectedAudit(actor, command, requestId)
    return domainVerification
  }

  try {
    const result = await db.transaction(async (transaction) => {
      await transaction
        .insert(workspaceSecuritySettings)
        .values({ workspaceId: actor.workspaceId })
        .onConflictDoNothing()
      const currentRows = await transaction
        .select()
        .from(workspaceSecuritySettings)
        .where(eq(workspaceSecuritySettings.workspaceId, actor.workspaceId))
        .limit(1)
      const current = currentRows.at(0)
      if (!current) throw new Error("Workspace security settings were missing.")
      if (current.version !== command.expectedVersion)
        return "conflict" as const

      if (command.type === "add-domain") {
        await transaction.insert(workspaceApprovedDomains).values({
          workspaceId: actor.workspaceId,
          domain: normalizedDomain(command.domain)!,
          source: "manual",
          verificationCode: `forge-domain-verification=${randomBytes(24).toString("base64url")}`,
          verificationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
          addedByUserId: actor.userId,
        })
      } else if (command.type === "verify-domain") {
        const verified = await transaction
          .update(workspaceApprovedDomains)
          .set({
            verifiedAt: new Date(),
            verificationCode: null,
            verificationExpiresAt: null,
          })
          .where(
            and(
              eq(workspaceApprovedDomains.id, command.domainId),
              eq(workspaceApprovedDomains.workspaceId, actor.workspaceId),
              eq(
                workspaceApprovedDomains.verificationCode,
                domainVerification!.verificationCode
              )
            )
          )
          .returning({ id: workspaceApprovedDomains.id })
        if (verified.length === 0) return "conflict" as const
      } else if (command.type === "remove-domain") {
        const deleted = await transaction
          .delete(workspaceApprovedDomains)
          .where(
            and(
              eq(workspaceApprovedDomains.id, command.domainId),
              eq(workspaceApprovedDomains.workspaceId, actor.workspaceId)
            )
          )
          .returning({ id: workspaceApprovedDomains.id })
        if (deleted.length === 0) return "not-found" as const
      }

      const values: Partial<typeof workspaceSecuritySettings.$inferInsert> = {
        version: current.version + 1,
        updatedAt: new Date(),
        updatedByUserId: actor.userId,
      }
      if (command.type === "set-boolean" || command.type === "set-policy") {
        Object.assign(values, { [command.key]: command.value })
      } else if (command.type === "reset-invite-link") {
        values.inviteLinkVersion = current.inviteLinkVersion + 1
      }

      const updated = await transaction
        .update(workspaceSecuritySettings)
        .set(values)
        .where(
          and(
            eq(workspaceSecuritySettings.workspaceId, actor.workspaceId),
            eq(workspaceSecuritySettings.version, current.version)
          )
        )
        .returning({ version: workspaceSecuritySettings.version })
      if (updated.length === 0) return "conflict" as const

      const audit = auditValues(command, current)
      await transaction.insert(workspaceSecurityAuditEvents).values({
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        action: audit.action,
        target: audit.target,
        outcome: "succeeded",
        before: audit.before,
        after: audit.after,
        requestId,
      })
      return "updated" as const
    })

    if (result === "conflict") {
      await writeRejectedAudit(actor, command, requestId)
      return {
        ok: false,
        code: "CONFLICT",
        message: "Security settings changed elsewhere. Refresh and try again.",
      }
    }
    if (result === "not-found") {
      await writeRejectedAudit(actor, command, requestId)
      return {
        ok: false,
        code: "NOT_FOUND",
        message: "The approved domain no longer exists.",
      }
    }
  } catch (error) {
    const constraint = constraintName(error)
    if (constraint.includes("workspace_approved_domains_domain_unique")) {
      await writeRejectedAudit(actor, command, requestId)
      return {
        ok: false,
        code: "DOMAIN_TAKEN",
        message: "This domain is already approved for another workspace.",
      }
    }
    if (
      constraint.includes("workspace_approved_domains_workspace_domain_unique")
    ) {
      await writeRejectedAudit(actor, command, requestId)
      return {
        ok: false,
        code: "DOMAIN_TAKEN",
        message: "This domain is already awaiting verification.",
      }
    }
    throw error
  }

  return {
    ok: true,
    snapshot: await buildSnapshot(actor, requestUrl),
  }
}

export async function getWorkspaceSecuritySettings(
  workspaceId: string,
  executor: DatabaseExecutor = db
) {
  return toSettings(await ensureSecurityRow(workspaceId, executor))
}

export async function getWorkspaceApiKeyPolicy(actor: Actor) {
  const row = await ensureSecurityRow(actor.workspaceId)
  const settings = toSettings(row)
  return {
    version: row.version,
    policy: settings.apiKeyCreationPolicy,
    canCreate: isWorkspaceActionAllowed(actor, settings, "api-keys.create"),
    canManage: hasWorkspaceRole(actor, ["owner", "admin"]),
  }
}

export async function assertWorkspaceActionAllowed(
  actor: Actor,
  action: WorkspaceSecurityAction
) {
  const settings = await getWorkspaceSecuritySettings(actor.workspaceId)
  if (!isWorkspaceActionAllowed(actor, settings, action)) {
    throw new WorkspaceSecurityAccessError(
      "FORBIDDEN",
      "Workspace security policy does not allow this action."
    )
  }
}

export async function canWorkspaceAction(
  actor: Actor,
  action: WorkspaceSecurityAction,
  executor: DatabaseExecutor = db
) {
  const settings = await getWorkspaceSecuritySettings(
    actor.workspaceId,
    executor
  )
  return isWorkspaceActionAllowed(actor, settings, action)
}

export async function getWorkspaceUploadPolicy(actor: Actor) {
  const settings = await getWorkspaceSecuritySettings(actor.workspaceId)
  return {
    restricted: settings.restrictFileUploads,
    allowedTypes: new Set(settings.allowedUploadTypes),
  }
}

export async function assertWorkspaceUploadAllowed(
  actor: Actor,
  contentType: string
) {
  const policy = await getWorkspaceUploadPolicy(actor)
  if (
    policy.restricted &&
    !contentType.startsWith("image/") &&
    !contentType.startsWith("video/") &&
    !policy.allowedTypes.has(contentType)
  ) {
    throw new WorkspaceSecurityAccessError(
      "FORBIDDEN",
      "Workspace security policy does not allow this file type."
    )
  }
}
