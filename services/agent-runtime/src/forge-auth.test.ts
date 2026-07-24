import { createHmac } from "node:crypto"

import { afterEach, describe, expect, it } from "vitest"

import { verifyForgeChannelRequest } from "./forge-auth.js"

const secret = "channel-auth-test-secret-with-at-least-32-characters"

function signTestToken(payload: Record<string, unknown>) {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" })
  ).toString("base64url")
  const claims = Buffer.from(
    JSON.stringify({
      ...payload,
      sub: "user-1",
      iss: "forge",
      aud: "forge-agent-runtime",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    })
  ).toString("base64url")
  const unsigned = `${header}.${claims}`
  const signature = createHmac("sha256", secret)
    .update(unsigned)
    .digest("base64url")
  return `${unsigned}.${signature}`
}

afterEach(() => {
  delete process.env.FORGE_AGENT_CHANNEL_SECRET
})

describe("Forge EVE channel authentication", () => {
  it("keeps run-bound capability and model proxy credentials in server attributes", async () => {
    process.env.FORGE_AGENT_CHANNEL_SECRET = secret
    const token = signTestToken({
      workspaceId: "workspace-1",
      runId: "00000000-0000-4000-8000-000000000001",
      forgeCapabilityToken: "capability-token-with-enough-length",
      forgeModelAccessToken: "model-access-token-with-enough-length",
      provider: "anthropic",
      modelId: "claude-sonnet",
      reasoningEffort: "none",
    })

    await expect(
      verifyForgeChannelRequest(
        new Request("http://runtime.test/eve/v1/session", {
          headers: { authorization: `Bearer ${token}` },
        })
      )
    ).resolves.toMatchObject({
      principalId: "user-1",
      attributes: {
        provider: "anthropic",
        modelId: "claude-sonnet",
        forgeCapabilityToken: "capability-token-with-enough-length",
        forgeModelAccessToken: "model-access-token-with-enough-length",
      },
    })
  })
})
