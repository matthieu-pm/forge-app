import { afterEach, describe, expect, it, vi } from "vitest"

import { isInvitationWorkflowEnabled } from "@/application/workflows/workflow-feature-flags.server"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("invitation workflow rollout", () => {
  it("requires both the global switch and exact workspace allowlist entry", () => {
    vi.stubEnv("FORGE_FEATURE_INVITATION_WORKFLOW", "true")
    vi.stubEnv(
      "FORGE_INVITATION_WORKFLOW_WORKSPACE_ALLOWLIST",
      "workspace-a, workspace-b"
    )

    expect(isInvitationWorkflowEnabled("workspace-b")).toBe(true)
    expect(isInvitationWorkflowEnabled("workspace-c")).toBe(false)
  })

  it("keeps allowlisted workspaces on the synchronous path when disabled", () => {
    vi.stubEnv("FORGE_FEATURE_INVITATION_WORKFLOW", "false")
    vi.stubEnv("FORGE_INVITATION_WORKFLOW_WORKSPACE_ALLOWLIST", "workspace-a")

    expect(isInvitationWorkflowEnabled("workspace-a")).toBe(false)
  })
})
