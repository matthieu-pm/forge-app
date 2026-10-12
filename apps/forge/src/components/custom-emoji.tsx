import { useCustomEmojis } from "./custom-emoji-provider"
import { isCustomEmoji } from "@/lib/custom-emoji-contract"

export function EmojiGlyph({ value }: { value: string }) {
  const { emojis } = useCustomEmojis()
  if (!isCustomEmoji(value)) return <>{value}</>
  const emoji = emojis.find((item) => item.value === value)
  return emoji ? (
    <img
      src={emoji.image}
      alt={`:${emoji.name}:`}
      className="size-full object-contain"
      draggable={false}
    />
  ) : (
    <span title="Emoji unavailable">◇</span>
  )
}
