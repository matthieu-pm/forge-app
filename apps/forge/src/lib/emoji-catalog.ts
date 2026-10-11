export const emojiCategoryDefinitions = [
  { id: "smileys-people", label: "Smileys & People", groups: [0, 1] },
  { id: "animals-nature", label: "Animals & Nature", groups: [3] },
  { id: "food-drink", label: "Food & Drink", groups: [4] },
  { id: "activity", label: "Activity", groups: [6] },
  { id: "travel-places", label: "Travel & Places", groups: [5] },
  { id: "objects", label: "Objects", groups: [7] },
  { id: "symbols", label: "Symbols", groups: [8] },
  { id: "flags", label: "Flags", groups: [9] },
  { id: "components", label: "Components", groups: [2] },
] as const

type EmojiCategoryId = (typeof emojiCategoryDefinitions)[number]["id"]
type EmojiData = {
  unicode: string
  hexcode: string
  label: string
  group?: number
  order?: number
  tags?: Array<string>
  skins?: Array<EmojiData>
}
export type EmojiChoice = {
  category: EmojiCategoryId
  emoji: string
  label: string
  search: string
  shortcode: string
}

const categoryByGroup = new Map<number, EmojiCategoryId>(
  emojiCategoryDefinitions.flatMap((category) =>
    category.groups.map((group) => [group, category.id] as const)
  )
)
const categoryOrder = new Map<EmojiCategoryId, number>(
  emojiCategoryDefinitions.map((category, index) => [category.id, index])
)

export function buildEmojiChoices(
  data: Array<EmojiData>,
  shortcodes: Record<string, string | Array<string> | undefined>
): Array<EmojiChoice> {
  const entries = new Map<string, EmojiData & { category: EmojiCategoryId }>()
  function add(emoji: EmojiData, parent?: EmojiData) {
    const group = emoji.group ?? parent?.group
    const category =
      group === undefined
        ? "components"
        : (categoryByGroup.get(group) ?? "components")
    entries.set(emoji.unicode, {
      ...emoji,
      tags: [...(parent?.tags ?? []), ...(emoji.tags ?? [])],
      category,
    })
    emoji.skins?.forEach((skin) => add(skin, emoji))
  }
  data.forEach((emoji) => add(emoji))
  return [...entries.values()]
    .sort(
      (a, b) =>
        categoryOrder.get(a.category)! - categoryOrder.get(b.category)! ||
        (a.order ?? Infinity) - (b.order ?? Infinity)
    )
    .map((emoji) => {
      const code = shortcodes[emoji.hexcode]
      const aliases = code ? (Array.isArray(code) ? code : [code]) : []
      const fallback = emoji.label
        .toLocaleLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "")
      return {
        category: emoji.category,
        emoji: emoji.unicode,
        label: emoji.label,
        search: [
          emoji.unicode,
          emoji.label,
          ...(emoji.tags ?? []),
          ...aliases,
          fallback,
        ]
          .join(" ")
          .toLocaleLowerCase(),
        shortcode: aliases[0] ?? fallback,
      }
    })
}
