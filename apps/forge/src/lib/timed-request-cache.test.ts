import { describe, expect, it, vi } from "vitest"

import { createTimedRequestCache } from "@/lib/timed-request-cache"

describe("createTimedRequestCache", () => {
  it("shares in-flight and recent requests until the TTL expires", async () => {
    let currentTime = 1_000
    const load = vi.fn(() => Promise.resolve({ workspace: "Forge" }))
    const loadCached = createTimedRequestCache(load, 5_000, () => currentTime)

    const first = loadCached()
    const second = loadCached()

    expect(second).toBe(first)
    await expect(first).resolves.toEqual({ workspace: "Forge" })
    expect(load).toHaveBeenCalledOnce()

    currentTime += 5_001
    await loadCached()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("does not retain failed requests", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("ready")
    const loadCached = createTimedRequestCache(load, 5_000)

    await expect(loadCached()).rejects.toThrow("offline")
    await expect(loadCached()).resolves.toBe("ready")
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("invalidates an in-flight request without letting it replace the next identity", async () => {
    let finishOld!: (value: string) => void
    const load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finishOld = resolve
          })
      )
      .mockResolvedValue("new workspace")
    const cached = createTimedRequestCache(load, 30_000)
    const old = cached()
    cached.clear()
    await expect(cached()).resolves.toBe("new workspace")
    finishOld("old workspace")
    await old
    await expect(cached()).resolves.toBe("new workspace")
    expect(load).toHaveBeenCalledTimes(2)
  })
})
