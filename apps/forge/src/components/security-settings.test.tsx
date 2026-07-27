import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SecuritySettings } from "./security-settings"
import type { WorkspaceSecuritySnapshot } from "@/application/workspace-security/security-contract"

const mocks = vi.hoisted(() => ({
  loadWorkspaceSecurity: vi.fn(),
  mutateWorkspaceSecurity: vi.fn(),
}))

vi.mock("@tanstack/react-router", async () => {
  const React = await import("react")

  return {
    Link: React.forwardRef<
      HTMLAnchorElement,
      React.ComponentProps<"a"> & { to: string }
    >(function MockLink({ to, ...props }, ref) {
      return <a ref={ref} href={to} {...props} />
    }),
  }
})

vi.mock("@/lib/security-state", () => ({
  loadWorkspaceSecurity: mocks.loadWorkspaceSecurity,
  mutateWorkspaceSecurity: mocks.mutateWorkspaceSecurity,
}))

function snapshot(): WorkspaceSecuritySnapshot {
  return {
    workspace: {
      id: "workspace-1",
      name: "Atrium",
      slug: "atriumcrm",
    },
    version: 1,
    canManage: true,
    plan: "free",
    entitlements: {
      "restrict-invitations": false,
      "restrict-guest-agents": false,
      "team-creation-policy": false,
      "workspace-label-policy": false,
      "workspace-template-policy": false,
      "loop-management-policy": false,
      "file-upload-restrictions": false,
      "application-approvals": false,
      "support-pii-reduction": false,
      "saml-scim": false,
      hipaa: false,
    },
    settings: {
      inviteLinksEnabled: true,
      googleAuthenticationEnabled: true,
      emailPasskeyAuthenticationEnabled: true,
      invitationPolicy: "all-members",
      teamCreationPolicy: "admins",
      workspaceLabelsPolicy: "admins",
      workspaceTemplatesPolicy: "admins",
      loopsPolicy: "admins",
      apiKeyCreationPolicy: "all-members",
      agentGuidancePolicy: "admins",
      restrictFileUploads: false,
      allowedUploadTypes: [],
      reviewThirdPartyApplications: false,
      reduceSupportPii: false,
      blockGuestAgentAccess: false,
      shareAiUsageData: false,
      agentWebSearchEnabled: false,
      externalLoopSourcesEnabled: false,
      mcpServersEnabled: false,
      hipaaEnabled: false,
    },
    inviteLink: "https://forge.test/join/signed-token",
    domains: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        domain: "humancrm.fr",
        source: "manual",
        verifiedAt: "2026-07-27T10:00:00.000Z",
        verificationCode: null,
        verificationExpiresAt: null,
        createdAt: "2026-07-27T10:00:00.000Z",
      },
    ],
    updatedAt: "2026-07-27T10:00:00.000Z",
  }
}

describe("SecuritySettings", () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadWorkspaceSecurity.mockResolvedValue(snapshot())
  })

  it("renders plan gates as billing buttons", () => {
    render(<SecuritySettings initialSnapshot={snapshot()} />)

    expect(
      screen.getByRole("heading", { level: 1, name: "Security" })
    ).toBeTruthy()
    expect(screen.getByText("Workspace access")).toBeTruthy()
    expect(screen.getByText("Workspace management")).toBeTruthy()
    expect(screen.getByText("Integrations & applications")).toBeTruthy()
    expect(screen.getByText("MCP Servers")).toBeTruthy()
    const enterpriseButtons = screen.getAllByRole("button", {
      name: "Available on Enterprise",
    })
    const basicButtons = screen.getAllByRole("button", {
      name: "Available on Basic",
    })
    const businessButtons = screen.getAllByRole("button", {
      name: "Available on Business",
    })

    expect(enterpriseButtons).toHaveLength(5)
    expect(basicButtons).toHaveLength(2)
    expect(businessButtons).toHaveLength(4)

    for (const button of [
      ...enterpriseButtons,
      ...basicButtons,
      ...businessButtons,
    ]) {
      expect(button.getAttribute("href")).toBe("/settings/billing")
    }
  })

  it("persists toggle changes through the server module", async () => {
    const updated = snapshot()
    updated.version = 2
    updated.settings.inviteLinksEnabled = false
    updated.inviteLink = null
    mocks.mutateWorkspaceSecurity.mockResolvedValue({
      ok: true,
      snapshot: updated,
    })
    render(<SecuritySettings initialSnapshot={snapshot()} />)

    const inviteLinks = screen.getByRole("switch", {
      name: "Enable invite links",
    })
    expect(inviteLinks.getAttribute("aria-checked")).toBe("true")

    fireEvent.click(inviteLinks)

    await waitFor(() => {
      expect(mocks.mutateWorkspaceSecurity).toHaveBeenCalledWith({
        data: {
          type: "set-boolean",
          key: "inviteLinksEnabled",
          value: false,
          expectedVersion: 1,
        },
      })
      expect(inviteLinks.getAttribute("aria-checked")).toBe("false")
    })
  })

  it("adds an approved email domain", async () => {
    const updated = snapshot()
    updated.version = 2
    updated.domains.push({
      id: "00000000-0000-4000-8000-000000000002",
      domain: "example.com",
      source: "manual",
      verifiedAt: null,
      verificationCode: "forge-domain-verification=test",
      verificationExpiresAt: "2026-07-28T10:01:00.000Z",
      createdAt: "2026-07-27T10:01:00.000Z",
    })
    mocks.mutateWorkspaceSecurity.mockResolvedValue({
      ok: true,
      snapshot: updated,
    })
    render(<SecuritySettings initialSnapshot={snapshot()} />)

    fireEvent.click(
      screen.getByRole("button", { name: "Add approved email domain" })
    )
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Email domain" }),
      {
        target: { value: "example.com" },
      }
    )
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }))

    expect(await screen.findByText("2 approved email domains")).toBeTruthy()
    expect(screen.getAllByText("example.com")).toHaveLength(2)
    expect(screen.getByText(/Pending DNS verification/)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Verify" }))
    await waitFor(() => {
      expect(mocks.mutateWorkspaceSecurity).toHaveBeenLastCalledWith({
        data: {
          type: "verify-domain",
          domainId: "00000000-0000-4000-8000-000000000002",
          expectedVersion: 2,
        },
      })
    })
  })
})
