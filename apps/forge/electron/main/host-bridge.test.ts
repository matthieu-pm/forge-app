import { describe, expect, it } from "vitest"

import { assertTrustedSender } from "./host-bridge"
import type { IpcMainInvokeEvent, WebFrameMain } from "electron"

function eventFor({
  frameUrl,
  mainFrame = true,
}: {
  frameUrl: string
  mainFrame?: boolean
}) {
  const trustedFrame = { url: frameUrl } as WebFrameMain
  const otherFrame = { url: frameUrl } as WebFrameMain
  return {
    senderFrame: trustedFrame,
    sender: {
      mainFrame: mainFrame ? trustedFrame : otherFrame,
    },
  } as unknown as IpcMainInvokeEvent
}

describe("desktop host bridge sender policy", () => {
  it("accepts only the main frame on the exact configured origin", () => {
    expect(() =>
      assertTrustedSender(
        eventFor({ frameUrl: "https://forge.example/settings/ai" }),
        "https://forge.example"
      )
    ).not.toThrow()

    expect(() =>
      assertTrustedSender(
        eventFor({
          frameUrl: "https://forge.example/embedded",
          mainFrame: false,
        }),
        "https://forge.example"
      )
    ).toThrow("main frame")

    expect(() =>
      assertTrustedSender(
        eventFor({ frameUrl: "https://forge.example.evil.test/" }),
        "https://forge.example"
      )
    ).toThrow()
  })

  it("rejects missing and malformed sender frames", () => {
    expect(() =>
      assertTrustedSender(
        {
          senderFrame: null,
          sender: { mainFrame: null },
        } as unknown as IpcMainInvokeEvent,
        "https://forge.example"
      )
    ).toThrow("main frame")

    expect(() =>
      assertTrustedSender(
        eventFor({ frameUrl: "not a URL" }),
        "https://forge.example"
      )
    ).toThrow("invalid origin")
  })
})
