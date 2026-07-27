import { afterEach, describe, expect, it, vi } from "vitest"

import { copyTextToClipboard } from "./copy-to-clipboard"

describe("copyTextToClipboard", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, "forgeDesktop")
    Reflect.deleteProperty(document, "execCommand")
  })

  it("uses the trusted desktop bridge when it is available", async () => {
    const copyText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, "forgeDesktop", {
      configurable: true,
      value: { copyText },
    })

    await copyTextToClipboard("invite-link")

    expect(copyText).toHaveBeenCalledWith("invite-link")
  })

  it("falls back to a selected textarea when clipboard-write is denied", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")),
      },
    })
    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    })

    await copyTextToClipboard("invite-link")

    expect(execCommand).toHaveBeenCalledWith("copy")
    expect(document.querySelector("textarea")).toBeNull()
  })
})
