import { describe, expect, it, vi } from "vitest"

import { setDockIconSafely } from "./dock-icon"

describe("setDockIconSafely", () => {
  it("does not abort desktop startup when macOS rejects the development icon", () => {
    const dock = {
      setIcon: vi.fn(() => {
        throw new Error("Failed to load image")
      }),
    }

    expect(() => setDockIconSafely(dock, "/tmp/forge.png")).not.toThrow()
    expect(dock.setIcon).toHaveBeenCalledWith("/tmp/forge.png")
  })
})
