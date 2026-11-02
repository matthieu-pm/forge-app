// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { dispatch } from "./loops"

const { dispatchLoops } = vi.hoisted(() => ({ dispatchLoops: vi.fn() }))
vi.mock("@/application/loops/loop-dispatch.server", () => ({ dispatchLoops }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})
describe("authenticated Loop web scheduler", () => {
  const secret = "for62-scheduler-unit-test-signing-secret-only"
  it("rejects missing, wrong and invalid-length credentials without touching the queue", async () => {
    vi.stubEnv("CRON_SECRET", secret)
    for (const auth of [
      "",
      "Bearer incorrect",
      `Bearer ${"é".repeat(secret.length)}`,
    ]) {
      expect(
        (
          await dispatch(
            new Request("http://localhost/api/internal/loops", {
              headers: { Authorization: auth },
            })
          )
        ).status
      ).toBe(401)
    }
    vi.stubEnv("CRON_SECRET", "")
    expect(
      (await dispatch(new Request("http://localhost/api/internal/loops")))
        .status
    ).toBe(401)
    expect(dispatchLoops).not.toHaveBeenCalled()
  })
  it("awaits one execution and returns its durable outcome rather than enqueueing only", async () => {
    vi.stubEnv("CRON_SECRET", secret)
    let resolve!: (result: unknown) => void
    dispatchLoops.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r
      })
    )
    const before = Date.now()
    const result = dispatch(
      new Request("http://localhost/api/internal/loops", {
        headers: { Authorization: `Bearer ${secret}` },
      })
    )
    await vi.waitFor(() => expect(dispatchLoops).toHaveBeenCalledOnce())
    expect(dispatchLoops.mock.calls[0][0]).toEqual({
      limit: 1,
      executionStartBefore: expect.any(Number),
    })
    expect(
      dispatchLoops.mock.calls[0][0].executionStartBefore
    ).toBeGreaterThanOrEqual(before + 20_000)
    resolve({ enabled: true, events: 1, scheduled: 0, executed: 1 })
    const response = await result
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(await response.json()).toEqual({
      enabled: true,
      events: 1,
      scheduled: 0,
      executed: 1,
    })
  })
})
