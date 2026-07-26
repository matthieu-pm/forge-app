import { describe, expect, it, vi } from "vitest"

import { runWorkflowStartAttempts } from "@/application/workflows/workflow-start-retry"

describe("workflow start retry policy", () => {
  it("stops after three failed attempts with bounded backoff", async () => {
    const start = vi.fn().mockRejectedValue(new Error("unavailable"))
    const beforeAttempt = vi.fn().mockResolvedValue(undefined)
    const onFailure = vi.fn()
    const wait = vi.fn().mockResolvedValue(undefined)

    await expect(
      runWorkflowStartAttempts({
        beforeAttempt,
        start,
        onFailure,
        wait,
        random: () => 0.5,
      })
    ).resolves.toBe(false)

    expect(start).toHaveBeenCalledTimes(3)
    expect(beforeAttempt).toHaveBeenCalledTimes(3)
    expect(onFailure).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenNthCalledWith(1, 187)
    expect(wait).toHaveBeenNthCalledWith(2, 437)
  })

  it("returns immediately after a successful retry", async () => {
    const start = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined)

    await expect(
      runWorkflowStartAttempts({
        beforeAttempt: vi.fn().mockResolvedValue(undefined),
        start,
        onFailure: vi.fn(),
        wait: vi.fn().mockResolvedValue(undefined),
        random: () => 0,
      })
    ).resolves.toBe(true)

    expect(start).toHaveBeenCalledTimes(2)
  })

  it("does not create another SDK run after the business run is claimed", async () => {
    const start = vi.fn()

    await expect(
      runWorkflowStartAttempts({
        beforeAttempt: vi.fn().mockResolvedValue(false),
        start,
        onFailure: vi.fn(),
      })
    ).resolves.toBe(true)

    expect(start).not.toHaveBeenCalled()
  })
})
