import { describe, expect, it } from "vitest"

import { validateAppOrigin, validateUpdateBaseUrl } from "./runtime-config"

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
})
