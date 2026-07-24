// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Actor } from "@/application/actor"
import {
  mintAgentCapabilityToken,
  verifyAgentCapabilityToken,
} from "@/application/agents/run-token.server"

const actor: Actor = {
  userId: "user-1",
  workspaceId: "workspace-1",
  workspaceRole: "member",
  authentication: { kind: "session", sessionId: "session-1" },
  scopes: null,
}

describe("agent capability token", () => {
  beforeEach(() => {
    process.env.FORGE_AGENT_CAPABILITY_SECRET =
      "test-secret-that-is-at-least-thirty-two-characters"
  })

  afterEach(() => {
    delete process.env.FORGE_AGENT_CAPABILITY_SECRET
  })

  it("reconstructs a run-scoped actor for an allowed capability", async () => {
    const runId = "00000000-0000-4000-8000-000000000001"
    const token = await mintAgentCapabilityToken({
      actor,
      runId,
      capabilities: ["teams.list"],
    })

    await expect(
      verifyAgentCapabilityToken(token, {
        runId,
        workspaceId: "workspace-1",
        capabilityId: "teams.list",
      })
    ).resolves.toMatchObject({
      userId: "user-1",
      workspaceId: "workspace-1",
      authentication: { kind: "agent", runId },
      scopes: ["teams:read"],
    })
  })

  it("rejects a different workspace, run, or capability", async () => {
    const runId = "00000000-0000-4000-8000-000000000001"
    const token = await mintAgentCapabilityToken({
      actor,
      runId,
      capabilities: ["teams.list"],
    })

    await expect(
      verifyAgentCapabilityToken(token, {
        runId,
        workspaceId: "workspace-2",
        capabilityId: "teams.list",
      })
    ).rejects.toThrow("outside its allowed scope")
  })
})
