// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Actor } from "@/application/actor"
import {
  mintLocalIngestToken,
  verifyLocalIngestToken,
} from "@/application/agents/local-ingest-token.server"

const actor: Actor = {
  userId: "user-1",
  workspaceId: "workspace-1",
  workspaceRole: "member",
  authentication: { kind: "session", sessionId: "session-1" },
  scopes: [],
}

const previousSecret = process.env.FORGE_AGENT_LOCAL_INGEST_SECRET

beforeEach(() => {
  process.env.FORGE_AGENT_LOCAL_INGEST_SECRET =
    "local-ingest-test-secret-with-at-least-32-characters"
})

afterEach(() => {
  if (previousSecret) {
    process.env.FORGE_AGENT_LOCAL_INGEST_SECRET = previousSecret
  } else {
    delete process.env.FORGE_AGENT_LOCAL_INGEST_SECRET
  }
})

describe("local runtime ingest token", () => {
  it("binds the token to the current user, workspace, thread, and run", async () => {
    const token = await mintLocalIngestToken({
      actor,
      runId: "00000000-0000-4000-8000-000000000010",
      threadId: "00000000-0000-4000-8000-000000000020",
    })
    await expect(
      verifyLocalIngestToken(token, {
        actor,
        runId: "00000000-0000-4000-8000-000000000010",
        threadId: "00000000-0000-4000-8000-000000000020",
      })
    ).resolves.toMatchObject({
      sub: "user-1",
      workspaceId: "workspace-1",
    })
  })

  it("rejects run or actor substitution", async () => {
    const token = await mintLocalIngestToken({
      actor,
      runId: "00000000-0000-4000-8000-000000000010",
      threadId: "00000000-0000-4000-8000-000000000020",
    })
    await expect(
      verifyLocalIngestToken(token, {
        actor: { ...actor, userId: "user-2" },
        runId: "00000000-0000-4000-8000-000000000011",
      })
    ).rejects.toThrow("outside its allowed scope")
  })
})
