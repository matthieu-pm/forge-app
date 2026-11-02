import { afterEach, describe, expect, it, vi } from "vitest"
import {
  LOOP_FUNCTION_DURATION_SECONDS,
  LOOP_RUN_WALL_CLOCK_MS,
  LOOP_SCHEDULER_SETUP_MS,
  LOOP_SETTLEMENT_GRACE_MS,
  withinLoopExecutionWindow,
} from "./loop-execution-policy"

afterEach(() => vi.useRealTimers())
describe("Loop web execution budget", () => {
  it("leaves room for settlement and request overhead within the deployed function", () => {
    expect(LOOP_RUN_WALL_CLOCK_MS).toBe(240_000)
    expect(
      LOOP_SCHEDULER_SETUP_MS +
        LOOP_RUN_WALL_CLOCK_MS +
        LOOP_SETTLEMENT_GRACE_MS
    ).toBeLessThan(LOOP_FUNCTION_DURATION_SECONDS * 1000)
  })
  it("settles an unresponsive executor as uncertain without waiting for cancellation", async () => {
    vi.useFakeTimers()
    const work = new Promise<never>(() => {})
    const result = withinLoopExecutionWindow(work, Date.now() + 250_000)
    const rejected = expect(result).rejects.toThrow(
      "UNCERTAIN_EXECUTION_TIMEOUT"
    )
    await vi.advanceTimersByTimeAsync(250_000)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  })
  it("cleans the deadline timer on confirmed completion and propagates failures", async () => {
    vi.useFakeTimers()
    await expect(
      withinLoopExecutionWindow(
        Promise.resolve("confirmed"),
        Date.now() + 250_000
      )
    ).resolves.toBe("confirmed")
    await expect(
      withinLoopExecutionWindow(
        Promise.reject(new Error("unknown start")),
        Date.now() + 250_000
      )
    ).rejects.toThrow("unknown start")
    expect(vi.getTimerCount()).toBe(0)
  })
})
