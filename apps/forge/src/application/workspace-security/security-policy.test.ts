import { describe, expect, it } from "vitest"

import type { Actor } from "@/application/actor"
import type { WorkspaceSecuritySettings } from "@/application/workspace-security/security-contract"
import {
  isWorkspaceActionAllowed,
  resolveEntitlements,
} from "@/application/workspace-security/security-policy"

const settings: WorkspaceSecuritySettings = {
  inviteLinksEnabled: true,
  googleAuthenticationEnabled: true,
  emailPasskeyAuthenticationEnabled: true,
  invitationPolicy: "admins",
  teamCreationPolicy: "admins",
  workspaceLabelsPolicy: "admins",
  workspaceTemplatesPolicy: "admins",
  loopsPolicy: "admins",
  apiKeyCreationPolicy: "admins",
  agentGuidancePolicy: "admins",
  restrictFileUploads: false,
  allowedUploadTypes: [],
  reviewThirdPartyApplications: true,
  reduceSupportPii: false,
  blockGuestAgentAccess: true,
  shareAiUsageData: false,
  agentWebSearchEnabled: false,
  externalLoopSourcesEnabled: false,
  mcpServersEnabled: false,
  hipaaEnabled: false,
}

function actor(workspaceRole: string): Actor {
  return {
    userId: "user-1",
    workspaceId: "workspace-1",
    workspaceRole,
    authentication: { kind: "session", sessionId: "session-1" },
    scopes: null,
  }
}

describe("workspace security policy", () => {
  it("maps plan hierarchy to entitlements", () => {
    expect(resolveEntitlements("free")["restrict-invitations"]).toBe(false)
    expect(resolveEntitlements("basic")["restrict-invitations"]).toBe(true)
    expect(resolveEntitlements("basic")["team-creation-policy"]).toBe(false)
    expect(resolveEntitlements("business")["team-creation-policy"]).toBe(true)
    expect(resolveEntitlements("enterprise").hipaa).toBe(true)
  })

  it("lets administrators satisfy admin-only policies", () => {
    expect(
      isWorkspaceActionAllowed(actor("admin"), settings, "members.invite")
    ).toBe(true)
    expect(
      isWorkspaceActionAllowed(actor("member"), settings, "members.invite")
    ).toBe(false)
  })

  it("blocks guest agent access and unapproved application installs", () => {
    expect(
      isWorkspaceActionAllowed(actor("guest"), settings, "agents.invoke")
    ).toBe(false)
    expect(
      isWorkspaceActionAllowed(
        actor("member"),
        settings,
        "applications.install"
      )
    ).toBe(false)
  })

  it("does not expose disabled agent capabilities", () => {
    expect(
      isWorkspaceActionAllowed(actor("admin"), settings, "agent.web-search")
    ).toBe(false)
    expect(
      isWorkspaceActionAllowed(actor("admin"), settings, "agent.mcp")
    ).toBe(false)
  })
})
