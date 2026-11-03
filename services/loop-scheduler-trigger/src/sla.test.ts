import { afterEach, describe, expect, it, vi } from "vitest"
import worker, { triggerSlaScheduler } from "./index"

const env: Env = {
  CRON_SECRET: "test-only-scheduler-signing-secret-not-production",
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
describe("Cloudflare SLA minute trigger", () => {
  it("sends only to the pinned authenticated GET and logs bounded counts", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ dispatched: 2, processed: 1, failed: false })
      )
    vi.stubGlobal("fetch", fetcher)
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await triggerSlaScheduler(env, 123)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]).toMatchObject([
      "https://app.forgenow.tech/api/internal/sla-jobs",
      {
        method: "GET",
        redirect: "manual",
        headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
      },
    ])
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      job: "forge.sla.scheduler",
      scheduledTime: 123,
      status: 200,
      dispatched: 2,
      processed: 1,
      failed: false,
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain(env.CRON_SECRET)
  })
  it.each([301, 302, 401, 404, 503])(
    "rejects HTTP %i without following redirects or logging bodies",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("private body", { status }))
      )
      const log = vi.spyOn(console, "error").mockImplementation(() => {})
      await expect(triggerSlaScheduler(env, 123)).rejects.toThrow(
        "invocation failed"
      )
      expect(JSON.stringify(log.mock.calls)).not.toContain("private body")
      expect(JSON.stringify(log.mock.calls)).not.toContain(env.CRON_SECRET)
      expect(fetch).toHaveBeenCalledOnce()
    }
  )
  it.each([
    "x".repeat(4097),
    "not JSON",
    JSON.stringify({ dispatched: 101, processed: 0, failed: false }),
    JSON.stringify({ dispatched: 1, processed: 21, failed: false }),
    JSON.stringify({ dispatched: 0, processed: 0, failed: true }),
  ])("rejects invalid or oversized receipts", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)))
    vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(triggerSlaScheduler(env, 123)).rejects.toThrow(
      "invocation failed"
    )
  })
  it("starts both tick requests even if one fails", async () => {
    const fetcher = vi.fn((url: string) =>
      url.endsWith("/loops")
        ? Promise.reject(new Error("unavailable"))
        : Promise.resolve(
            Response.json({ dispatched: 0, processed: 0, failed: false })
          )
    )
    vi.stubGlobal("fetch", fetcher)
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(
      worker.scheduled(
        { scheduledTime: 123, cron: "* * * * *", noRetry() {} },
        env
      )
    ).rejects.toThrow("tick failed")
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(worker.fetch().status).toBe(404)
  })
})
