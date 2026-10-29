// @vitest-environment node
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  STAGING,
  assertStagingEnvironment,
} from "../../../../packages/environment/staging-environment"
import { STAGING_INTEGRATIONS } from "../../../../packages/environment/staging-credentials"

vi.mock("@tanstack/react-start/server-only", () => ({}))

// Explicit opt-in; ordinary test runs never use local developer/provider credentials.
const environmentFile = process.env.FORGE_STAGING_PROVIDER_TEST_ENV
describe.skipIf(!environmentFile)("registered staging providers", () => {
  beforeAll(() => {
    const env = JSON.parse(readFileSync(environmentFile!, "utf8")) as Record<
      string,
      string
    >
    assertStagingEnvironment(
      { ...env, VERCEL: "1", VERCEL_PROJECT_ID: STAGING.webProjectId },
      "web"
    )
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  })
  afterAll(() => vi.unstubAllEnvs())

  it("executes a small real response through the authenticated managed model proxy", async () => {
    const { mintAgentModelAccessToken } =
      await import("@/application/agents/model-access-token.server")
    const { managedOpenAIConnectionIdForWorkspace } =
      await import("@/application/agents/managed-openai-models.server")
    const { handleOpenAIModelProxyRequest } =
      await import("@/application/agents/openai-model-proxy.server")
    const workspaceId = randomUUID()
    const token = await mintAgentModelAccessToken({
      actor: {
        userId: randomUUID(),
        workspaceId,
        workspaceRole: "owner",
        authentication: { kind: "session", sessionId: randomUUID() },
        scopes: null,
      },
      runId: randomUUID(),
      connectionId: managedOpenAIConnectionIdForWorkspace(workspaceId),
      provider: "openai",
      modelId: STAGING_INTEGRATIONS.openaiModel,
      expiresInSeconds: 60,
    })
    const response = await handleOpenAIModelProxyRequest(
      new Request(`${STAGING.webOrigin}/api/agent/runtime/model/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: STAGING_INTEGRATIONS.openaiModel,
          input: "Reply with exactly: FOR27-STAGING-OK",
          max_output_tokens: 128,
          reasoning: { effort: "low" },
          store: false,
        }),
      }),
      "responses"
    )
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.status).toBe("completed")
    expect(
      data.output.some(
        (item: { type: string; content?: Array<{ text?: string }> }) =>
          item.content?.some((part) => part.text?.includes("FOR27-STAGING-OK"))
      )
    ).toBe(true)
  }, 60_000)

  it("delivers synthetic mail only to Resend's test destination", async () => {
    const { sendTransactionalEmail } =
      await import("@/application/mail/mail.server")
    const result = await sendTransactionalEmail({
      to: "delivered@resend.dev",
      subject: "FOR-27 staging provider verification",
      text: "Synthetic staging fixture. No customer data.",
      react: <p>Synthetic staging fixture. No customer data.</p>,
      category: "email-verification",
      idempotencyKey: `for27-staging:${randomUUID()}`,
    })
    expect(result.id.length).toBeGreaterThan(0)
  }, 30_000)

  it("reads only the registered Polar sandbox organization", async () => {
    const response = await fetch(
      "https://sandbox-api.polar.sh/v1/products/?limit=10",
      {
        headers: {
          authorization: `Bearer ${process.env.POLAR_ACCESS_TOKEN}`,
          "user-agent": "Forge-Staging/1.0",
        },
        redirect: "error",
      }
    )
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.items.length).toBeGreaterThan(0)
    expect(
      data.items.every(
        (item: { organization_id: string }) =>
          item.organization_id === STAGING_INTEGRATIONS.polarOrganizationId
      )
    ).toBe(true)
  }, 30_000)

  it("builds Google authorization with the registered client and exact staging callback", async () => {
    const { authorizationUrl, configuredProviders } =
      await import("@/application/calls/providers.server")
    expect(configuredProviders()).toEqual(["google", "zoom"])
    const url = new URL(
      authorizationUrl("google", randomUUID(), "synthetic-pkce-challenge")
    )
    expect(url.searchParams.get("client_id")).toBe(
      STAGING_INTEGRATIONS.googleClientId
    )
    expect(url.searchParams.get("redirect_uri")).toBe(
      STAGING_INTEGRATIONS.meetingRedirectUri
    )
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/meetings.space.readonly"
    )
    const zoom = new URL(
      authorizationUrl("zoom", randomUUID(), "synthetic-pkce-challenge")
    )
    expect(zoom.searchParams.get("client_id")).toBe(
      STAGING_INTEGRATIONS.zoomClientId
    )
    expect(zoom.searchParams.get("redirect_uri")).toBe(
      STAGING_INTEGRATIONS.meetingRedirectUri
    )
  })
})
