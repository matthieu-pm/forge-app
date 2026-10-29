// @vitest-environment node
import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import {
  operationsAcceptance,
  receiveOperatorAcceptance,
} from "../../../../../packages/telemetry/health-acceptance"
import { STAGING } from "../../../../../packages/environment/staging-environment"
import { alertEnvelope } from "./monitor"

const now = Date.now(),
  token = "t".repeat(43),
  challenge = "a".repeat(32)
const env = {
  FORGE_ENVIRONMENT: "staging",
  VERCEL_PROJECT_ID: STAGING.runtimeProjectId,
  FORGE_SOURCE_REVISION: "a".repeat(40),
  FORGE_OPERATIONS_CHECK_TOKEN_SHA256: createHash("sha256")
    .update(token)
    .digest("hex"),
  FORGE_OPERATIONS_CHECK_EXPIRES_AT: new Date(now + 60_000).toISOString(),
}
const request = () =>
  new Request("https://runtime.test/internal/operations-inbox", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-environment-check-challenge": challenge,
    },
  })

describe("isolated operational acceptance authority", () => {
  it("denies non-staging, wrong-project, expired, excessive-lifetime and anonymous probes before collection", async () => {
    const collect = vi.fn()
    for (const values of [
      { ...env, FORGE_ENVIRONMENT: "production" },
      { ...env, VERCEL_PROJECT_ID: STAGING.webProjectId },
      {
        ...env,
        FORGE_OPERATIONS_CHECK_EXPIRES_AT: new Date(now - 1).toISOString(),
      },
      {
        ...env,
        FORGE_OPERATIONS_CHECK_EXPIRES_AT: new Date(
          now + 7_200_001
        ).toISOString(),
      },
      { ...env, FORGE_OPERATIONS_CHECK_TOKEN_SHA256: "b".repeat(64) },
    ]) {
      expect(
        (await operationsAcceptance(request(), values, "runtime", collect, now))
          .status
      ).toBe(404)
    }
    expect(
      (
        await operationsAcceptance(
          new Request("https://runtime.test", { method: "POST" }),
          env,
          "runtime",
          collect,
          now
        )
      ).status
    ).toBe(404)
    expect(collect).not.toHaveBeenCalled()
  })
  it("the test operator receives only a bounded source-pinned page and never extra payload fields", async () => {
    const logger = vi.spyOn(console, "info").mockImplementation(() => {})
    try {
      const alert = alertEnvelope(
        {
          code: "SWEEP_STALE",
          signal: "agent.retention",
          severity: "page",
          since: now - 3_601_000,
          value: 3_601,
          threshold: 3_600,
        },
        "staging",
        env.FORGE_SOURCE_REVISION
      )
      const original = request()
      const result = await receiveOperatorAcceptance(
        new Request(original, {
          body: JSON.stringify({ ...alert, privateBody: "PRIVATE-FIXTURE" }),
        }),
        env,
        now
      )
      expect(result.status).toBe(200)
      expect(await result.json()).toEqual({
        challenge,
        accepted: true,
        id: alert.id,
      })
      expect(logger).toHaveBeenCalledOnce()
      expect(logger.mock.calls[0][0]).toContain(alert.runbookUrl)
      expect(logger.mock.calls[0][0]).not.toMatch(/PRIVATE-FIXTURE|Bearer/)
    } finally {
      logger.mockRestore()
    }
  })
})
