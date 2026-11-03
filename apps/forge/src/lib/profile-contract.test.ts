import { describe, expect, it } from "vitest"
import { MAX_AVATAR_BYTES, profileCommandSchema } from "./profile-contract"

const command = {
  commandKey: "00000000-0000-4000-8000-000000000001",
  sessionId: "session",
  expectedWorkspaceId: "workspace",
  expectedRevision: "2026-11-03T00:00:00.000Z",
  patch: { title: "Engineer" },
}
describe("profile command contract", () => {
  it("bounds plain text and rejects empty or protected mixed patches", () => {
    for (const patch of [
      {},
      { title: "ok", role: "owner" },
      { name: " " },
      { name: "a".repeat(81) },
      { title: "a".repeat(81) },
      { title: "bad\u0000title" },
      { username: "Bad username" },
    ])
      expect(
        profileCommandSchema.safeParse({ ...command, patch }).success
      ).toBe(false)
    expect(
      profileCommandSchema.parse({
        ...command,
        patch: { name: " Alice ", title: " Engineer " },
      }).patch
    ).toEqual({ name: "Alice", title: "Engineer" })
  })
  it("rejects external/active avatar content and oversized data before decoding", () => {
    for (const image of [
      "javascript:alert(1)",
      "https://example.test/picture.png",
      "data:image/svg+xml;base64,PHN2Zz4=",
      `data:image/png;base64,${"A".repeat(MAX_AVATAR_BYTES * 2)}`,
    ])
      expect(
        profileCommandSchema.safeParse({ ...command, patch: { image } }).success
      ).toBe(false)
  })
})
