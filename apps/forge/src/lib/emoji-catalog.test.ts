import { describe, expect, it } from "vitest"
import data from "emojibase-data/en/compact.json"
import shortcodes from "emojibase-data/en/shortcodes/emojibase.json"
import { buildEmojiChoices } from "./emoji-catalog"

describe("Complete emoji catalog", () => {
  it("keeps every Unicode entry, including skin variants and components", () => {
    const expected = new Set<string>()
    function visit(emoji: (typeof data)[number]) {
      expected.add(emoji.unicode)
      emoji.skins?.forEach(visit)
    }
    data.forEach(visit)
    const choices = buildEmojiChoices(data, shortcodes)
    expect(new Set(choices.map((choice) => choice.emoji))).toEqual(expected)
    expect(choices.find((choice) => choice.emoji === "🇦")?.category).toBe(
      "components"
    )
    expect(choices.find((choice) => choice.emoji === "🏻")?.category).toBe(
      "components"
    )
  })
  it("searches skin variants by inherited tags, Unicode, and their own shortcode", () => {
    const choices = buildEmojiChoices(data, shortcodes)
    const wave = choices.find((choice) => choice.emoji === "👋🏿")!
    expect(wave.search).toContain("hello")
    expect(wave.search).toContain("👋🏿")
    expect(wave.search).toContain("dark skin tone")
    expect(wave.search).toContain(wave.shortcode)
    expect(
      choices.filter((choice) => choice.label.startsWith("waving hand"))
    ).toHaveLength(6)
  })
})
