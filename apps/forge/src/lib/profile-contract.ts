import { z } from "zod"
import { profileTitleSchema, usernameSchema } from "./profile-fields"

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024
const plainText = z
  .string()
  .trim()
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const code = character.charCodeAt(0)
        return code === 127 || (code < 32 && ![9, 10, 13].includes(code))
      }),
    "Remove control characters."
  )
export const profileValuesSchema = z
  .object({
    name: plainText.pipe(z.string().min(1).max(80)),
    title: plainText.pipe(profileTitleSchema),
    username: usernameSchema.nullable(),
    image: z
      .string()
      .max(Math.ceil(MAX_AVATAR_BYTES / 3) * 4 + 64)
      .regex(
        /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
        "Choose a PNG, JPEG or WebP image."
      )
      .nullable(),
  })
  .strict()
export const profileCommandSchema = z
  .object({
    commandKey: z.string().uuid(),
    sessionId: z.string().min(1).max(255),
    expectedWorkspaceId: z.string().min(1).max(255),
    expectedRevision: z.string().datetime(),
    patch: profileValuesSchema
      .partial()
      .refine((patch) => Object.keys(patch).length > 0),
  })
  .strict()
export type ProfileCommand = z.infer<typeof profileCommandSchema>
export type ProfileSnapshot = {
  userId: string
  revision: string
  name: string
  title: string
  username: string | null
  image: string | null
}
export type ProfileLoadResult =
  { status: "disabled" } | { status: "ready"; snapshot: ProfileSnapshot }
export type ProfileSaveResult = {
  status: "saved" | "conflict"
  snapshot: ProfileSnapshot
}
