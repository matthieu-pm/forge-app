// @vitest-environment node
import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

import { handleEnvironmentCheck } from "./environment-check"

const token = "a".repeat(43)
const configuration = {
  tokenSha256: createHash("sha256").update(token).digest("hex"),
  expiresAt: "2026-10-29T01:00:00Z",
}
const now = Date.parse("2026-10-28T23:00:00Z")
const challenge = "b".repeat(32)
function request(secret = token, value = challenge) {
  return new Request("https://forge.test/api/internal/environment", {
    headers: {
      authorization: `Bearer ${secret}`,
      "x-environment-check-challenge": value,
    },
  })
}

describe("operator environment check", () => {
  it.each([
    [{}, request()],
    [configuration, new Request("https://forge.test/api/internal/environment")],
    [configuration, request("c".repeat(43))],
    [{ ...configuration, expiresAt: "invalid" }, request()],
    [{ ...configuration, expiresAt: new Date(now).toISOString() }, request()],
    [{ ...configuration, tokenSha256: "invalid" }, request()],
  ])(
    "denies missing, wrong or expired authority without touching data",
    async (config, input) => {
      const collect = vi.fn()
      const response = await handleEnvironmentCheck(input, config, collect, now)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe("")
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(collect).not.toHaveBeenCalled()
    }
  )

  it("returns the result for the supplied challenge only after authorization", async () => {
    const collect = vi.fn((value: string) =>
      Promise.resolve({
        challenge: value,
        branch: "production",
      })
    )
    const response = await handleEnvironmentCheck(
      request(),
      configuration,
      collect,
      now
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ challenge, branch: "production" })
    expect(collect).toHaveBeenCalledExactlyOnceWith(challenge)
  })

  it("rejects invalid challenge input before querying", async () => {
    const collect = vi.fn()
    expect(
      (
        await handleEnvironmentCheck(
          request(token, "select secrets"),
          configuration,
          collect,
          now
        )
      ).status
    ).toBe(400)
    expect(collect).not.toHaveBeenCalled()
  })

  it("redacts errors from the database and prevents response caching", async () => {
    const response = await handleEnvironmentCheck(
      request(),
      configuration,
      () => Promise.reject(new Error("postgres://secret@database")),
      now
    )
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('{"error":"Environment check failed"}')
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
})
