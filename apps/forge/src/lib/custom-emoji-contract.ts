import { z } from "zod"

export const customEmojiInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .toLowerCase()
      .regex(
        /^[a-z0-9][a-z0-9_-]{0,63}$/,
        "Use letters, numbers, hyphens, or underscores."
      ),
    image: z
      .string()
      .max(350_000)
      .regex(
        /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/,
        "Choose a valid PNG image."
      ),
  })
  .strict()
export type CustomEmojiInput = z.infer<typeof customEmojiInputSchema>
export type CustomEmoji = CustomEmojiInput & {
  id: string
  value: string
  createdAt: string
  sourceName: string
  sourceImage: string | null
  canRemove: boolean
}
export function emojiNameFromFile(filename: string) {
  return (
    filename
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "emoji"
  )
}
export function customEmojiValue(id: string) {
  return `:e_${id.replaceAll("-", "").slice(0, 24)}:`
}
export function isCustomEmoji(value: string) {
  return /^:e_[a-f0-9]{24}:$/.test(value)
}
