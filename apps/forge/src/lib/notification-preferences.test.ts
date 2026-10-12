import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  channelSummary,
  initialNotificationPreferences,
  notificationPreferencesKey,
  useNotificationPreferences,
} from "./notification-preferences"

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe("notification preferences", () => {
  it("persists choices per user without changing other channels", () => {
    const view = renderHook(() => useNotificationPreferences("first"))
    act(() => {
      view.result.current.update((current) => ({
        ...current,
        priorityInbox: true,
      }))
    })
    view.unmount()
    const restored = renderHook(() => useNotificationPreferences("first"))
    const other = renderHook(() => useNotificationPreferences("second"))
    expect(restored.result.current.settings.priorityInbox).toBe(true)
    expect(other.result.current.settings.priorityInbox).toBe(false)
    expect(restored.result.current.settings.channels).toEqual(
      initialNotificationPreferences().channels
    )
  })

  it("merges with the latest stored settings and synchronizes mounted consumers", () => {
    const first = renderHook(() => useNotificationPreferences("first"))
    const second = renderHook(() => useNotificationPreferences("first"))
    const external = initialNotificationPreferences()
    external.updates.changelog = true
    localStorage.setItem(
      notificationPreferencesKey("first"),
      JSON.stringify(external)
    )
    act(() => {
      first.result.current.update((current) => ({
        ...current,
        priorityInbox: true,
      }))
    })
    expect(second.result.current.settings).toMatchObject({
      priorityInbox: true,
      updates: { changelog: true },
    })
  })

  it("preserves corrupt storage and rejects writes instead of overwriting it", () => {
    const key = notificationPreferencesKey("first")
    localStorage.setItem(key, "invalid")
    const view = renderHook(() => useNotificationPreferences("first"))
    expect(view.result.current.error).toContain("preserved")
    expect(view.result.current.update(initialNotificationPreferences)).toBe(
      false
    )
    expect(localStorage.getItem(key)).toBe("invalid")
  })

  it("retains the visible value when persistence fails", () => {
    const view = renderHook(() => useNotificationPreferences("first"))
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota")
    })
    let saved = true
    act(() => {
      saved = view.result.current.update((current) => ({
        ...current,
        priorityInbox: true,
      }))
    })
    expect(saved).toBe(false)
    expect(view.result.current.settings.priorityInbox).toBe(false)
  })

  it("summarizes effective channel selections including empty and disabled channels", () => {
    const defaults = initialNotificationPreferences().channels
    expect(channelSummary(defaults.desktop)).toBe(
      "Enabled for assignments, status changes, 12 others"
    )
    expect(channelSummary(defaults.mobile)).toBe(
      "Enabled for all notifications"
    )
    expect(channelSummary(defaults.slack)).toBe("Disabled")
    expect(channelSummary({ enabled: true, types: [] })).toBe("Disabled")
    expect(channelSummary({ enabled: true, types: ["mentions"] })).toBe(
      "Enabled for mentions"
    )
  })
})
