// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Actor } from "@/application/actor"
import {
  mintAgentModelAccessToken,
  verifyAgentModelAccessToken,
} from "@/application/agents/model-access-token.server"

const actor: Actor = {
  userId: "user-1",
  workspaceId: "workspace-1",
  workspaceRole: "member",
  authentication: { kind: "session", sessionId: "session-1" },
  scopes: null,
}

const previousSecret = process.env.FORGE_AGENT_MODEL_ACCESS_SECRET

beforeEach(() => {
  process.env.FORGE_AGENT_MODEL_ACCESS_SECRET =
    "model-access-test-secret-with-at-least-32-characters"
})

afterEach(() => {
  if (previousSecret) {
    process.env.FORGE_AGENT_MODEL_ACCESS_SECRET = previousSecret
  } else {
    delete process.env.FORGE_AGENT_MODEL_ACCESS_SECRET
  }
})

describe("agent model access token", () => {
  it("binds one short-lived token to user, workspace, run, connection, and model", async () => {
    const token = await mintAgentModelAccessToken({
      actor,
      runId: "00000000-0000-4000-8000-000000000010",
      connectionId: "00000000-0000-4000-8000-000000000020",
      provider: "openai",
      modelId: "gpt-5.6-luna",
    })

    await expect(verifyAgentModelAccessToken(token)).resolves.toMatchObject({
      sub: actor.userId,
      workspaceId: actor.workspaceId,
      runId: "00000000-0000-4000-8000-000000000010",
      connectionId: "00000000-0000-4000-8000-000000000020",
      provider: "openai",
      modelId: "gpt-5.6-luna",
    })
  })
})
