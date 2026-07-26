import { describe, expect, it } from "vitest"

import {
  desktopAuthScheme,
  desktopAuthorizationUrl,
  resolveDesktopAuthScheme,
  validateAppOrigin,
  validateUpdateBaseUrl,
} from "./runtime-config"

describe("desktop runtime URLs", () => {
  it("requires an exact HTTPS application origin", () => {
    expect(validateAppOrigin("https://app.forge.com/")).toBe(
      "https://app.forge.com"
    )
    expect(() => validateAppOrigin("http://app.forge.com")).toThrow()
    expect(() => validateAppOrigin("https://app.forge.com/path")).toThrow()
    expect(() => validateAppOrigin("https://user@app.forge.com")).toThrow()
  })

  it("preserves a safe path on the HTTPS update service base URL", () => {
    expect(validateUpdateBaseUrl("https://updates.forge.com/desktop/")).toBe(
      "https://updates.forge.com/desktop"
    )
    expect(() => validateUpdateBaseUrl("http://updates.forge.com")).toThrow()
    expect(() =>
      validateUpdateBaseUrl("https://updates.forge.com/desktop?channel=beta")
    ).toThrow()
  })

  it("isolates development authentication callbacks from installed builds", () => {
    expect(resolveDesktopAuthScheme(false)).toBe("com.forge.desktop.dev")
    expect(resolveDesktopAuthScheme(true)).toBe(desktopAuthScheme)
    expect(
      desktopAuthorizationUrl(
        "http://localhost:3000",
        resolveDesktopAuthScheme(false)
      ).toString()
    ).toBe(
      "http://localhost:3000/auth/desktop?callback_protocol=com.forge.desktop.dev"
    )
  })
})
