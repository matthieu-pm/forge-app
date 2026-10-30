import { describe, expect, it, vi } from "vitest"
import { handleIssueRetention } from "./issue-retention-handler"

const secret = "x".repeat(48),
  env = {
    FORGE_ISSUE_RETENTION_ENABLED: "true",
    FORGE_ISSUE_RETENTION_SECRET: secret,
  }
const request = (authorization = `Bearer ${secret}`) =>
  new Request("https://app.example.test/api/internal/issue-retention", {
    headers: { authorization },
  })
describe("issue retention scheduler boundary", () => {
  it("denies missing, wrong and disabled authorization before loading the worker", async () => {
    const run = vi.fn()
    for (const header of ["", "Bearer wrong"])
      expect(
        (await handleIssueRetention(request(header), env, run)).status
      ).toBe(404)
    expect(
      (
        await handleIssueRetention(
          request(),
          { ...env, FORGE_ISSUE_RETENTION_ENABLED: "false" },
          run
        )
      ).status
    ).toBe(404)
    expect(run).not.toHaveBeenCalled()
  })
  it("reports bounded successful work without caching it", async () => {
    const response = await handleIssueRetention(request(), env, async () => ({
      purged: 1,
      failed: 0,
      pending: true,
    }))
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({
      purged: 1,
      failed: 0,
      pending: true,
    })
  })
  it("reports failure without advancing to a false success or returning provider details", async () => {
    expect(
      (
        await handleIssueRetention(request(), env, async () => ({
          purged: 0,
          failed: 1,
        }))
      ).status
    ).toBe(503)
    const response = await handleIssueRetention(request(), env, async () => {
      throw new Error("private provider token")
    })
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain("private")
  })
})
