import { describe, expect, it } from "vitest"
import {
  customEmojiInputSchema,
  customEmojiValue,
  emojiNameFromFile,
} from "./custom-emoji-contract"
import { teamIconSchema } from "./team-contract"
import { prepareEmojiImage } from "./custom-emoji-upload"

describe("custom emoji validation", () => {
  it("normalizes upload filenames and accepts custom references in team icons", () => {
    expect(emojiNameFromFile("My Team Logo.PNG")).toBe("my-team-logo")
    expect(
      teamIconSchema.safeParse({
        kind: "emoji",
        value: customEmojiValue("11111111-1111-4111-8111-111111111111"),
        color: "#94a3b8",
      }).success
    ).toBe(true)
  })
  it("rejects active image formats, unsafe names and oversized data", () => {
    const valid = {
      name: "logo",
      image: "data:image/png;base64,iVBORw0KGgoAAA==",
    }
    expect(customEmojiInputSchema.safeParse(valid).success).toBe(true)
    expect(
      customEmojiInputSchema.safeParse({ ...valid, name: "../logo" }).success
    ).toBe(false)
    expect(
      customEmojiInputSchema.safeParse({
        ...valid,
        image: "data:image/svg+xml,<svg/>",
      }).success
    ).toBe(false)
    expect(
      customEmojiInputSchema.safeParse({
        ...valid,
        image: valid.image + "a".repeat(350_000),
      }).success
    ).toBe(false)
  })
  it("rejects unsupported and oversized files before decoding", async () => {
    await expect(
      prepareEmojiImage(new File(["x"], "x.svg", { type: "image/svg+xml" }))
    ).rejects.toThrow("PNG")
    await expect(
      prepareEmojiImage(
        new File([new Uint8Array(2 * 1024 * 1024 + 1)], "x.png", {
          type: "image/png",
        })
      )
    ).rejects.toThrow("2 MB")
  })
})
