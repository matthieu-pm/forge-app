import { describe, expect, it, vi } from "vitest"

import type { ForgeDesktopBridge, HostEvent } from "@/host/forge-host"
import { createForgeHost } from "@/host/forge-host"

describe("createForgeHost", () => {
  it("provides browser behavior when no desktop bridge exists", async () => {
    const host = createForgeHost()

    await expect(host.getRuntime()).resolves.toEqual({
      platform: "web",
      hostVersion: null,
      capabilities: [],
    })
  })

  it("delegates native behavior through the typed desktop bridge", async () => {
    const listener = vi.fn()
    const unsubscribe = vi.fn()
    const event: HostEvent = {
      type: "navigate",
      path: "/inbox",
    }
    const bridge: ForgeDesktopBridge = {
      getRuntime: vi.fn().mockResolvedValue({
        platform: "macos",
        hostVersion: "1.0.0",
        capabilities: ["dock-badge", "deep-links"],
      }),
      openExternal: vi.fn().mockResolvedValue(undefined),
      setUnreadCount: vi.fn().mockResolvedValue(undefined),
      showNotification: vi.fn().mockResolvedValue(undefined),
      openWindow: vi.fn().mockResolvedValue(undefined),
      beginAuth: vi.fn().mockResolvedValue(undefined),
      completeAuth: vi.fn().mockResolvedValue(undefined),
      adoptAuthSession: vi.fn().mockResolvedValue({ returnTo: "/inbox" }),
      signOut: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn((callback) => {
        callback(event)
        return unsubscribe
      }),
    }

    const host = createForgeHost(bridge)

    await expect(host.getRuntime()).resolves.toEqual({
      platform: "macos",
      hostVersion: "1.0.0",
      capabilities: ["dock-badge", "deep-links"],
    })
    await host.setUnreadCount(3)
    await host.beginAuth({ returnTo: "/inbox" })
    const stop = host.subscribe(listener)

    expect(bridge.setUnreadCount).toHaveBeenCalledWith(3)
    expect(bridge.beginAuth).toHaveBeenCalledWith({ returnTo: "/inbox" })
    expect(listener).toHaveBeenCalledWith(event)
    expect(stop).toBe(unsubscribe)
  })
})
