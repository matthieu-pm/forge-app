import type { Actor } from "@/application/actor"
import type {
  WorkspacePlan,
  WorkspacePolicy,
  WorkspaceSecurityAction,
  WorkspaceSecurityFeature,
  WorkspaceSecuritySettings,
} from "@/application/workspace-security/security-contract"
import { hasWorkspaceRole } from "@/application/authorization"

const PLAN_RANK: Record<WorkspacePlan, number> = {
  free: 0,
  basic: 1,
  business: 2,
  enterprise: 3,
}

export const REQUIRED_PLAN: Record<WorkspaceSecurityFeature, WorkspacePlan> = {
  "restrict-invitations": "basic",
  "restrict-guest-agents": "basic",
  "team-creation-policy": "business",
  "workspace-label-policy": "business",
  "workspace-template-policy": "business",
  "loop-management-policy": "business",
  "file-upload-restrictions": "enterprise",
  "application-approvals": "enterprise",
  "support-pii-reduction": "enterprise",
  "saml-scim": "enterprise",
  hipaa: "enterprise",
}

export function resolveEntitlements(
  plan: WorkspacePlan,
  overrides: Record<string, boolean> = {}
) {
  return Object.fromEntries(
    Object.entries(REQUIRED_PLAN).map(([feature, requiredPlan]) => [
      feature,
      overrides[feature] ?? PLAN_RANK[plan] >= PLAN_RANK[requiredPlan],
    ])
  ) as Record<WorkspaceSecurityFeature, boolean>
}

function policyAllows(actor: Actor, policy: WorkspacePolicy) {
  return policy === "all-members" || hasWorkspaceRole(actor, ["owner", "admin"])
}

export function isAgentInvocationAllowed(
  actor: Actor,
  settings: Pick<WorkspaceSecuritySettings, "blockGuestAgentAccess">
) {
  return !settings.blockGuestAgentAccess || !hasWorkspaceRole(actor, ["guest"])
}

export function isWorkspaceActionAllowed(
  actor: Actor,
  settings: WorkspaceSecuritySettings,
  action: WorkspaceSecurityAction
) {
  if (action === "security.manage") {
    return hasWorkspaceRole(actor, ["owner", "admin"])
  }

  const policyByAction: Partial<
    Record<WorkspaceSecurityAction, WorkspacePolicy>
  > = {
    "members.invite": settings.invitationPolicy,
    "teams.create": settings.teamCreationPolicy,
    "workspace-labels.manage": settings.workspaceLabelsPolicy,
    "workspace-templates.manage": settings.workspaceTemplatesPolicy,
    "loops.manage": settings.loopsPolicy,
    "api-keys.create": settings.apiKeyCreationPolicy,
    "agent-guidance.manage": settings.agentGuidancePolicy,
  }
  const policy = policyByAction[action]
  if (policy && !policyAllows(actor, policy)) return false

  if (action === "agents.invoke")
    return isAgentInvocationAllowed(actor, settings)
  if (action === "applications.install") {
    return (
      !settings.reviewThirdPartyApplications ||
      hasWorkspaceRole(actor, ["owner", "admin"])
    )
  }
  if (action === "agent.web-search") return settings.agentWebSearchEnabled
  if (action === "agent.mcp") return settings.mcpServersEnabled
  if (action === "loops.trigger-external") {
    return settings.externalLoopSourcesEnabled
  }
  if (action === "ai-usage.share") return settings.shareAiUsageData

  return true
}
