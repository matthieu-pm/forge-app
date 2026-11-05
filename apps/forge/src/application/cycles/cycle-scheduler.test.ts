// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { inspectServiceConfiguration } from "../../../../../packages/environment/service-config"
import { handleCycleScheduler } from "./cycle-scheduler"

const secret = "cycle-scheduler-test-secret-with-32-characters"
const request = (token = secret, method = "GET") =>
  new Request("https://forge.test/api/internal/cycle-rollover", {
    method,
    headers: { authorization: `Bearer ${token}` },
  })
const env = { CRON_SECRET: secret, FORGE_CYCLE_ROLLOVER_JOBS_ENABLED: "true" }
describe("cycle rollover scheduler", () => {
  it("requires an enabled scheduler, a long secret, and exact authentication before any database work", async () => {
    const run = vi.fn()
    for (const [req, config] of [
      [request(), {}],
      [request("wrong"), env],
      [request(secret, "POST"), env],
      [request(), { ...env, CRON_SECRET: "short" }],
    ] as const) {
      const response = await handleCycleScheduler(req, config, run)
      expect(response.status).toBe(404)
      expect(response.headers.get("cache-control")).toBe("no-store")
    }
    expect(run).not.toHaveBeenCalled()
    expect(
      inspectServiceConfiguration(
        { FORGE_CYCLE_ROLLOVER_JOBS_ENABLED: "true" },
        "app"
      ).issues
    ).toContainEqual(expect.objectContaining({ variable: "CRON_SECRET" }))
  })
  it("reports worker failures and exposes bounded counts without job inputs or exception payloads", async () => {
    const response = await handleCycleScheduler(request(), env, async () => ({
      dispatched: 2,
      results: [{ state: "completed" }, { state: "retry" }],
    }))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      dispatched: 2,
      processed: 2,
      failed: true,
    })
    const error = await handleCycleScheduler(request(), env, async () => {
      throw new Error("private issue data")
    })
    expect(await error.json()).toEqual({ code: "CYCLE_ROLLOVER_FAILED" })
  })
  it("treats disabled-workspace deferral as a deliberate pause", async () => {
    const response = await handleCycleScheduler(request(), env, async () => ({
      dispatched: 0,
      results: [{ state: "deferred" }],
    }))
    expect(response.status).toBe(200)
  })
})
