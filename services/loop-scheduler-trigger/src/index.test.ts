import { afterEach, describe, expect, it, vi } from "vitest"
import worker, { triggerScheduler } from "./index"

const env: Env = {
  CRON_SECRET: "test-only-scheduler-signing-secret-not-production",
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
describe("Cloudflare minute trigger", () => {
  it("sends one authenticated POST to the pinned web scheduler and records only receipt counts", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ enabled: true, events: 2, scheduled: 1, executed: 1 })
      )
    vi.stubGlobal("fetch", fetcher)
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await triggerScheduler(env, 123)
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, request] = fetcher.mock.calls[0]
    expect(url).toBe("https://app.forgenow.tech/api/internal/loops")
    expect(request).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
    })
    expect(request.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      job: "forge.loops.scheduler",
      scheduledTime: 123,
      status: 200,
      enabled: true,
      events: 2,
      scheduled: 1,
      executed: 1,
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain(env.CRON_SECRET)
  })
  it("awaits completion rather than dropping a long web execution", async () => {
    let finish!: (response: Response) => void
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve
          })
      )
    )
    vi.spyOn(console, "log").mockImplementation(() => {})
    let settled = false
    const result = triggerScheduler(env, 123).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    finish(
      Response.json({ enabled: true, events: 0, scheduled: 0, executed: 1 })
    )
    await result
    expect(settled).toBe(true)
  })
  it("does not retry or log credentials when the transport fails", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValue(new Error(`transport included ${env.CRON_SECRET}`))
    vi.stubGlobal("fetch", fetcher)
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(triggerScheduler(env, 123)).rejects.toThrow(
      "Forge scheduler invocation failed"
    )
    expect(fetcher).toHaveBeenCalledOnce()
    expect(JSON.stringify(log.mock.calls)).not.toContain(env.CRON_SECRET)
  })
  it.each([401, 404, 503])(
    "marks HTTP %i as failed without consuming or logging its response",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("private response", { status }))
      )
      const log = vi.spyOn(console, "error").mockImplementation(() => {})
      await expect(triggerScheduler(env, 123)).rejects.toThrow(
        "invocation failed"
      )
      expect(JSON.stringify(log.mock.calls)).not.toContain("private response")
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
        failureStage: "http",
        status,
      })
    }
  )
  it.each([
    "x".repeat(4097),
    "invalid JSON",
    JSON.stringify({ enabled: true, events: 0, scheduled: 0, executed: 2 }),
    JSON.stringify({ enabled: true, events: -1, scheduled: 0, executed: 0 }),
  ])("rejects malformed or excessive receipts", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)))
    vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(triggerScheduler(env, 123)).rejects.toThrow(
      "invocation failed"
    )
  })
  it("accepts explicit server-side disablement and keeps public HTTP requests inert", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ enabled: false, events: 0, scheduled: 0, executed: 0 })
      )
    vi.stubGlobal("fetch", fetcher)
    vi.spyOn(console, "log").mockImplementation(() => {})
    await triggerScheduler(env, 123)
    expect(worker.fetch().status).toBe(404)
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it("rejects a missing secret before any network request", async () => {
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    await expect(triggerScheduler({ CRON_SECRET: "" }, 123)).rejects.toThrow(
      "binding is missing"
    )
    expect(fetcher).not.toHaveBeenCalled()
  })
})
