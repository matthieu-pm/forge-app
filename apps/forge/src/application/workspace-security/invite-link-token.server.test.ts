// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  signWorkspaceInviteLink,
  verifyWorkspaceInviteLink,
} from "@/application/workspace-security/invite-link-token.server"

describe("workspace invite-link tokens", () => {
  beforeEach(() => {
    vi.stubEnv(
      "FORGE_INVITE_LINK_SECRET",
      "test-only-invite-link-secret-that-is-long-enough"
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("round-trips workspace and generation claims", async () => {
    const token = await signWorkspaceInviteLink({
      workspaceId: "workspace-1",
      generation: 4,
    })

    await expect(verifyWorkspaceInviteLink(token)).resolves.toEqual({
      workspaceId: "workspace-1",
      generation: 4,
    })
  })

  it("rejects a modified bearer token", async () => {
    const token = await signWorkspaceInviteLink({
      workspaceId: "workspace-1",
      generation: 4,
    })
    const replacement = token.endsWith("a") ? "b" : "a"

    await expect(
      verifyWorkspaceInviteLink(`${token.slice(0, -1)}${replacement}`)
    ).rejects.toThrow()
  })
})
