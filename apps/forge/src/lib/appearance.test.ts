import { beforeEach, describe, expect, it } from "vitest"

import {
  appearanceBootstrapScript,
  appearanceCacheStorageKey,
  appearanceForAccount,
  readAppearanceCache,
  writeAppearanceCache,
} from "./appearance"
import { defaultPersonalPreferences } from "./personal-preference-contract"

const lightChoice = {
  interfaceTheme: "light" as const,
  lightTheme: "paper" as const,
  darkTheme: "midnight" as const,
}

describe("appearance choice", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("uses a user cache only while that account is still loading", () => {
    writeAppearanceCache(localStorage, "alice", {
      interfaceTheme: "dark",
      lightTheme: "paper",
      darkTheme: "forest",
    })
    const cached = readAppearanceCache(localStorage, "alice")

    expect(
      appearanceForAccount({
        userId: null,
        values: null,
        preferences: lightChoice,
        status: "signed-out",
        cached,
      })
    ).toMatchObject({ interfaceTheme: "system" })
    expect(
      appearanceForAccount({
        userId: "bob",
        values: {},
        preferences: defaultPersonalPreferences,
        status: "loading",
        cached: readAppearanceCache(localStorage, "bob"),
      }).interfaceTheme
    ).toBe("system")
    expect(
      appearanceForAccount({
        userId: "alice",
        values: {},
        preferences: defaultPersonalPreferences,
        status: "loading",
        cached,
      }).darkTheme
    ).toBe("forest")
    expect(
      appearanceForAccount({
        userId: "alice",
        values: { "general.interfaceTheme": "light" },
        preferences: lightChoice,
        status: "loading",
        cached,
      })
    ).toMatchObject({ interfaceTheme: "light", lightTheme: "paper" })
    expect(
      appearanceForAccount({
        userId: "alice",
        values: {},
        preferences: lightChoice,
        status: "ready",
        cached,
      }).interfaceTheme
    ).toBe("light")
    for (const status of ["error", "conflict", "disabled"]) {
      expect(
        appearanceForAccount({
          userId: "alice",
          values: {},
          preferences: defaultPersonalPreferences,
          status,
          cached,
        }).darkTheme
      ).toBe("forest")
    }
  })

  it("ignores another account's cache and damaged records", () => {
    localStorage.setItem(
      appearanceCacheStorageKey("alice"),
      JSON.stringify({ interfaceTheme: "dark", darkTheme: "nope" })
    )
    localStorage.setItem("forge.appearance", JSON.stringify(lightChoice))

    expect(readAppearanceCache(localStorage, "alice")).toBeNull()
    expect(readAppearanceCache(localStorage, "bob")).toBeNull()
    expect(readAppearanceCache(localStorage, " ")).toBeNull()
  })

  it("paints only the system default before a session user is known", () => {
    localStorage.setItem(
      appearanceCacheStorageKey("alice"),
      JSON.stringify({
        interfaceTheme: "dark",
        lightTheme: "paper",
        darkTheme: "midnight",
      })
    )
    document.documentElement.className = ""
    delete document.documentElement.dataset.forgeTheme
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: true }),
    })

    const run = new Function(appearanceBootstrapScript)
    run()

    expect(document.documentElement.classList.contains("dark")).toBe(true)
    expect(document.documentElement.dataset.forgeTheme).toBe("dark")
    expect(document.documentElement.dataset.forgeAppearance).toBe("system")
    expect(document.documentElement.style.colorScheme).toBe("dark")
    expect(localStorage.getItem(appearanceCacheStorageKey("alice"))).toContain(
      "midnight"
    )
  })
})
