import { describe, expect, it, vi } from "vitest"

import {
  beginDesktopAuthorizationRedirect,
  desktopAuthorizationQuery,
} from "./auth-session"

describe("desktopAuthorizationQuery", () => {
  it("accepts a complete Electron PKCE request", () => {
    expect(
      desktopAuthorizationQuery(
        "?client_id=electron&state=state-1&code_challenge=challenge-1&code_challenge_method=S256"
      )
    ).toEqual({
      client_id: "electron",
      state: "state-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
    })
  })

  it("rejects incomplete or unexpected authorization requests", () => {
    expect(
      desktopAuthorizationQuery("?client_id=electron&state=state-1")
    ).toBeNull()
    expect(
      desktopAuthorizationQuery(
        "?client_id=browser&state=state-1&code_challenge=challenge-1&code_challenge_method=S256"
      )
    ).toBeNull()
  })
})

describe("beginDesktopAuthorizationRedirect", () => {
  it("starts the bounded redirect watcher only for Electron auth", () => {
    const ensureElectronRedirect = vi.fn()

    expect(
      beginDesktopAuthorizationRedirect(
        "?client_id=electron&state=state-1&code_challenge=challenge-1&code_challenge_method=S256",
        ensureElectronRedirect
      )
    ).toBe(true)
    expect(ensureElectronRedirect).toHaveBeenCalledWith({ timeout: 30_000 })

    expect(
      beginDesktopAuthorizationRedirect(
        "?redirect=%2Finbox",
        ensureElectronRedirect
      )
    ).toBe(false)
    expect(ensureElectronRedirect).toHaveBeenCalledTimes(1)
  })
})
