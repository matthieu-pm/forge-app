import { afterEach, describe, expect, it, vi } from "vitest"

import { authorizeDesktopReleaseRequest } from "@/application/desktop-releases/desktop-release-auth.server"
import { registerDesktopReleaseSchema } from "@/application/desktop-releases/desktop-release-contract"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("desktop release boundary", () => {
  it("accepts only the protected bearer credential", () => {
    vi.stubEnv("FORGE_DESKTOP_RELEASE_API_SECRET", "release-secret")

    expect(
      authorizeDesktopReleaseRequest(
        new Request("https://forge.test", {
          headers: { authorization: "Bearer release-secret" },
        })
      )
    ).toBe(true)
    expect(
      authorizeDesktopReleaseRequest(
        new Request("https://forge.test", {
          headers: { authorization: "Bearer another-secret" },
        })
      )
    ).toBe(false)
  })

  it("rejects malformed or mutable artifact metadata", () => {
    const parsed = registerDesktopReleaseSchema.safeParse({
      version: "1.2.3",
      releaseNotes: "",
      artifacts: [
        {
          platform: "darwin",
          architecture: "arm64",
          kind: "dmg",
          objectKey: "desktop/latest/Forge.dmg",
          sha256: "not-a-checksum",
          sizeBytes: 0,
        },
      ],
    })

    expect(parsed.success).toBe(false)
  })
})
