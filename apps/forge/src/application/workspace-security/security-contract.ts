import { z } from "zod"

export const workspacePlanSchema = z.enum([
  "free",
  "basic",
  "business",
  "enterprise",
])
export type WorkspacePlan = z.infer<typeof workspacePlanSchema>

export const workspacePolicySchema = z.enum(["all-members", "admins"])
export type WorkspacePolicy = z.infer<typeof workspacePolicySchema>

export const securityBooleanSettingSchema = z.enum([
  "inviteLinksEnabled",
  "googleAuthenticationEnabled",
  "emailPasskeyAuthenticationEnabled",
  "restrictFileUploads",
  "reviewThirdPartyApplications",
  "reduceSupportPii",
  "blockGuestAgentAccess",
  "shareAiUsageData",
  "agentWebSearchEnabled",
  "externalLoopSourcesEnabled",
  "mcpServersEnabled",
  "hipaaEnabled",
])
export type SecurityBooleanSetting = z.infer<
  typeof securityBooleanSettingSchema
>

export const securityPolicySettingSchema = z.enum([
  "invitationPolicy",
  "teamCreationPolicy",
  "workspaceLabelsPolicy",
  "workspaceTemplatesPolicy",
  "loopsPolicy",
  "apiKeyCreationPolicy",
  "agentGuidancePolicy",
])
export type SecurityPolicySetting = z.infer<typeof securityPolicySettingSchema>

export const workspaceSecurityActionSchema = z.enum([
  "security.manage",
  "members.invite",
  "teams.create",
  "workspace-labels.manage",
  "workspace-templates.manage",
  "loops.manage",
  "api-keys.create",
  "agent-guidance.manage",
  "agents.invoke",
  "attachments.upload",
  "applications.install",
  "agent.web-search",
  "agent.mcp",
  "loops.trigger-external",
  "ai-usage.share",
])
export type WorkspaceSecurityAction = z.infer<
  typeof workspaceSecurityActionSchema
>

export const workspaceSecurityFeatureSchema = z.enum([
  "restrict-invitations",
  "restrict-guest-agents",
  "team-creation-policy",
  "workspace-label-policy",
  "workspace-template-policy",
  "loop-management-policy",
  "file-upload-restrictions",
  "application-approvals",
  "support-pii-reduction",
  "saml-scim",
  "hipaa",
])
export type WorkspaceSecurityFeature = z.infer<
  typeof workspaceSecurityFeatureSchema
>

export const setSecurityBooleanCommandSchema = z
  .object({
    type: z.literal("set-boolean"),
    key: securityBooleanSettingSchema,
    value: z.boolean(),
    expectedVersion: z.number().int().positive(),
  })
  .strict()

export const setSecurityPolicyCommandSchema = z
  .object({
    type: z.literal("set-policy"),
    key: securityPolicySettingSchema,
    value: workspacePolicySchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict()

export const addApprovedDomainCommandSchema = z
  .object({
    type: z.literal("add-domain"),
    domain: z.string().trim().min(1).max(253),
    expectedVersion: z.number().int().positive(),
  })
  .strict()

export const removeApprovedDomainCommandSchema = z
  .object({
    type: z.literal("remove-domain"),
    domainId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
  })
  .strict()

export const verifyApprovedDomainCommandSchema = z
  .object({
    type: z.literal("verify-domain"),
    domainId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
  })
  .strict()

export const resetInviteLinkCommandSchema = z
  .object({
    type: z.literal("reset-invite-link"),
    expectedVersion: z.number().int().positive(),
  })
  .strict()

export const workspaceSecurityCommandSchema = z.discriminatedUnion("type", [
  setSecurityBooleanCommandSchema,
  setSecurityPolicyCommandSchema,
  addApprovedDomainCommandSchema,
  removeApprovedDomainCommandSchema,
  verifyApprovedDomainCommandSchema,
  resetInviteLinkCommandSchema,
])
export type WorkspaceSecurityCommand = z.infer<
  typeof workspaceSecurityCommandSchema
>

export const approvedDomainSummarySchema = z
  .object({
    id: z.string().uuid(),
    domain: z.string(),
    source: z.enum(["manual", "sso"]),
    verifiedAt: z.iso.datetime().nullable(),
    verificationCode: z.string().nullable(),
    verificationExpiresAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict()

export const workspaceSecuritySettingsSchema = z
  .object({
    inviteLinksEnabled: z.boolean(),
    googleAuthenticationEnabled: z.boolean(),
    emailPasskeyAuthenticationEnabled: z.boolean(),
    invitationPolicy: workspacePolicySchema,
    teamCreationPolicy: workspacePolicySchema,
    workspaceLabelsPolicy: workspacePolicySchema,
    workspaceTemplatesPolicy: workspacePolicySchema,
    loopsPolicy: workspacePolicySchema,
    apiKeyCreationPolicy: workspacePolicySchema,
    agentGuidancePolicy: workspacePolicySchema,
    restrictFileUploads: z.boolean(),
    allowedUploadTypes: z.array(z.string()),
    reviewThirdPartyApplications: z.boolean(),
    reduceSupportPii: z.boolean(),
    blockGuestAgentAccess: z.boolean(),
    shareAiUsageData: z.boolean(),
    agentWebSearchEnabled: z.boolean(),
    externalLoopSourcesEnabled: z.boolean(),
    mcpServersEnabled: z.boolean(),
    hipaaEnabled: z.boolean(),
  })
  .strict()
export type WorkspaceSecuritySettings = z.infer<
  typeof workspaceSecuritySettingsSchema
>

export const workspaceSecuritySnapshotSchema = z
  .object({
    workspace: z
      .object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
      })
      .strict(),
    version: z.number().int().positive(),
    canManage: z.boolean(),
    plan: workspacePlanSchema,
    entitlements: z.record(workspaceSecurityFeatureSchema, z.boolean()),
    settings: workspaceSecuritySettingsSchema,
    inviteLink: z.string().url().nullable(),
    domains: z.array(approvedDomainSummarySchema),
    updatedAt: z.iso.datetime(),
  })
  .strict()
export type WorkspaceSecuritySnapshot = z.infer<
  typeof workspaceSecuritySnapshotSchema
>

export type WorkspaceSecurityMutationResult =
  | { ok: true; snapshot: WorkspaceSecuritySnapshot }
  | {
      ok: false
      code:
        | "CONFLICT"
        | "DOMAIN_TAKEN"
        | "FORBIDDEN"
        | "NOT_FOUND"
        | "PLAN_REQUIRED"
        | "VALIDATION_FAILED"
      message: string
      requiredPlan?: WorkspacePlan
    }
