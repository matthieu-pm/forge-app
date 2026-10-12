import { describe, expect, it } from "vitest"
import {
  accountSessionDevice,
  accountSessionLastSeen,
} from "./account-session-display"

describe("account session display", () => {
  it("identifies desktop, Edge, and mobile browsers without misclassifying Chrome", () => {
    expect(accountSessionDevice("Electron Macintosh").name).toBe(
      "Forge Desktop on macOS"
    )
    expect(accountSessionDevice("Windows Chrome/130 Edg/130").name).toBe(
      "Edge on Windows"
    )
    expect(accountSessionDevice("Android Chrome/130").name).toBe(
      "Chrome on Android"
    )
    expect(accountSessionDevice("iPhone CriOS/130 Safari/537").name).toBe(
      "Chrome on iOS"
    )
    expect(accountSessionDevice(null).name).toBe("Browser")
  })
  it("handles unavailable dates", () => {
    expect(accountSessionLastSeen("invalid")).toBe("Last seen unavailable")
  })
})
