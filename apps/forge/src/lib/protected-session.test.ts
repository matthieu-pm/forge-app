import { describe, expect, it, vi } from "vitest"
import { inProtectedSession, retireProtectedSession } from "./protected-session"
import {
  invalidatePreferenceSession,
  onPreferenceSessionInvalidated,
} from "./preference-session-events"

describe("FOR-52 protected request generations", () => {
  it("aborts old transport work and rejects a late result even when transport ignores abort", async () => {
    let finish!: (value: string) => void
    let signal!: AbortSignal
    const old = inProtectedSession((abort) => {
      signal = abort
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    })
    const rejected = expect(old).rejects.toThrow("active session changed")
    invalidatePreferenceSession("start")
    expect(signal.aborted).toBe(true)
    await expect(inProtectedSession(async () => "B private")).resolves.toBe(
      "B private"
    )
    finish("A private")
    await rejected
  })
  it("invalidates other tabs without receiving or trusting private identity data", () => {
    const listener = vi.fn()
    const unsubscribe = onPreferenceSessionInvalidated(listener)
    const old = inProtectedSession(async (signal) => signal)
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "forge:session-transition:v1",
        newValue: JSON.stringify({ phase: "start", nonce: "one" }),
      })
    )
    expect(listener).toHaveBeenCalledWith("start")
    unsubscribe()
    retireProtectedSession()
    return expect(old).rejects.toThrow("active session changed")
  })
})
