import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { AccountPreferenceProvider } from "./account-preference-provider"
import { PersonalPreferenceEffects } from "./personal-preference-effects"
import type { ReactNode } from "react"
import { readAppearanceCache, writeAppearanceCache } from "@/lib/appearance"
import { emptyPreferenceSnapshot } from "@/lib/account-preference-contract"

const gate = vi.hoisted(() => {
  let ready = false
  const listeners = new Set<() => void>()
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ready: () => ready,
    setReady(next: boolean) {
      ready = next
      for (const listener of listeners) listener()
    },
  }
})

vi.mock("@/components/product-state-provider", async () => {
  const React = await import("react")
  return {
    ProductStateProvider: ({ children }: { children: ReactNode }) => {
      const ready = React.useSyncExternalStore(
        gate.subscribe,
        gate.ready,
        () => false
      )
      return ready ? children : <p>Loading your workspace…</p>
    },
  }
})

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  load: vi.fn(),
}))

vi.mock("@/lib/auth-state", () => ({ getAuthState: mocks.auth }))
vi.mock("@/lib/account-preference-state", () => ({
  loadAccountPreferences: mocks.load,
  saveAccountPreferences: vi.fn(),
}))

function media() {
  let matches = true
  const listeners = new Set<() => void>()
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      get matches() {
        return matches
      },
      addEventListener: (_event: string, listener: () => void) => {
        listeners.add(listener)
      },
      removeEventListener: (_event: string, listener: () => void) => {
        listeners.delete(listener)
      },
    }),
  })
  return {
    listeners,
    set(next: boolean) {
      matches = next
      for (const listener of listeners) listener()
    },
  }
}

function session(userId: string | null) {
  return userId
    ? {
        user: { id: userId },
        session: { id: `session-${userId}` },
        workspace: { id: "workspace" },
      }
    : { user: null, session: null, workspace: null }
}

function snapshot(
  userId: string,
  revision: number,
  values: Record<string, unknown> = {}
) {
  return {
    ...emptyPreferenceSnapshot(userId),
    revision,
    values,
    fieldVersions: Object.fromEntries(
      Object.keys(values).map((key) => [key, revision])
    ),
  }
}

describe("appearance sessions", () => {
  let scheme: ReturnType<typeof media>
  let saved: ReturnType<typeof snapshot>

  beforeEach(() => {
    localStorage.clear()
    document.documentElement.className = ""
    delete document.documentElement.dataset.forgeTheme
    delete document.documentElement.dataset.forgeAppearance
    document.documentElement.style.colorScheme = ""
    scheme = media()
    gate.setReady(false)
    saved = snapshot("alice", 1)
    mocks.auth.mockReset()
    mocks.auth.mockResolvedValue(session(null))
    mocks.load.mockReset()
    mocks.load.mockImplementation(() =>
      Promise.resolve({
        status: "ready",
        snapshot: saved,
      })
    )
  })

  afterEach(() => {
    cleanup()
    gate.setReady(false)
  })

  it("keeps a fresh session on the saved choice and follows the OS only for system", async () => {
    writeAppearanceCache(localStorage, "alice", {
      interfaceTheme: "dark",
      lightTheme: "paper",
      darkTheme: "midnight",
    })
    writeAppearanceCache(localStorage, "bob", {
      interfaceTheme: "dark",
      lightTheme: "light",
      darkTheme: "forest",
    })
    render(
      <AccountPreferenceProvider>
        <PersonalPreferenceEffects />
      </AccountPreferenceProvider>
    )

    await waitFor(() =>
      expect(document.documentElement.dataset.forgeAppearance).toBe("system")
    )
    expect(document.documentElement.dataset.forgeTheme).toBe("dark")
    expect(document.documentElement.dataset.forgeTheme).not.toBe("forest")

    mocks.auth.mockResolvedValue(session("alice"))
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    await screen.findByText("Loading your workspace…")
    await waitFor(() =>
      expect(document.documentElement.dataset.forgeTheme).toBe("midnight")
    )
    expect(scheme.listeners.size).toBe(0)
    scheme.set(false)
    expect(document.documentElement.dataset.forgeTheme).toBe("midnight")

    saved = snapshot("alice", 1, {
      "general.interfaceTheme": "light",
      "general.lightTheme": "paper",
      "general.darkTheme": "midnight",
    })
    act(() => gate.setReady(true))
    await waitFor(() =>
      expect(document.documentElement.dataset.forgeAppearance).toBe("light")
    )
    expect(document.documentElement.dataset.forgeTheme).toBe("paper")
    expect(document.documentElement.style.colorScheme).toBe("light")
    scheme.set(true)
    expect(document.documentElement.dataset.forgeTheme).toBe("paper")

    saved = snapshot("alice", 2, {
      "general.interfaceTheme": "system",
      "general.lightTheme": "paper",
      "general.darkTheme": "forest",
    })
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    await waitFor(() =>
      expect(document.documentElement.dataset.forgeTheme).toBe("forest")
    )
    scheme.set(false)
    await waitFor(() =>
      expect(document.documentElement.dataset.forgeTheme).toBe("paper")
    )
    expect(document.documentElement.dataset.forgeAppearance).toBe("system")

    saved = snapshot("bob", 1)
    mocks.auth.mockResolvedValue(session("bob"))
    scheme.set(true)
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    await waitFor(() => {
      expect(readAppearanceCache(localStorage, "bob")?.interfaceTheme).toBe(
        "system"
      )
      expect(document.documentElement.dataset.forgeAppearance).toBe("system")
      expect(document.documentElement.dataset.forgeTheme).toBe("dark")
    })
    expect(document.documentElement.dataset.forgeTheme).not.toBe("paper")
    expect(document.documentElement.dataset.forgeTheme).not.toBe("forest")
  })
})
