import { describe, expect, it, vi } from "vitest"
import { callForgeCapability } from "./forge-client.js"
import { verifyForgeChannelRequest } from "./forge-auth.js"

const runId = "00000000-0000-4000-8000-000000000001"
const correlationId = "00000000-0000-4000-8000-000000000002"

describe("correlated runtime callbacks", () => {
  it("propagates correlation/run identity and excludes payloads from failure diagnostics", async () => {
    const sensitive =
      "sk-fixture private transcript https://test/file?sig=secret"
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: { message: sensitive } }, { status: 500 })
      )
    vi.stubGlobal("fetch", fetcher)
    vi.stubEnv("FORGE_APP_ORIGIN", "https://forge.test")
    try {
      await expect(
        callForgeCapability(
          {
            workspaceId: "workspace-1",
            runId,
            correlationId,
            capabilityToken: sensitive,
          },
          {
            id: "teams.update",
            version: "1",
            input: { description: sensitive },
            idempotencyKey: sensitive,
          }
        )
      ).rejects.toThrow("Forge capability request failed.")
      expect(fetcher).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-correlation-id": correlationId,
            "x-forge-agent-run-id": runId,
          }),
        })
      )
      const logs = log.mock.calls.map(([line]) => JSON.parse(String(line)))
      expect(logs).toContainEqual(
        expect.objectContaining({
          event: "forge.operation.failed",
          service: "runtime",
          correlationId,
          runId,
        })
      )
      expect(JSON.stringify(log.mock.calls)).not.toContain(sensitive)
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
      log.mockRestore()
    }
  })
  it("does not authenticate an untrusted correlation header without a channel token", async () => {
    const result = await verifyForgeChannelRequest(
      new Request("https://runtime.test/eve/v1/session", {
        headers: { "x-correlation-id": correlationId },
      })
    )
    expect(result).toBeNull()
  })
})
