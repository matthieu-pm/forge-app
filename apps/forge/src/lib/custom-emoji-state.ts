import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { customEmojiInputSchema } from "./custom-emoji-contract"

export const listCustomEmojis = createServerFn({ method: "GET" }).handler(
  async () => {
    const [{ getRequest }, { requireSessionActor }, { listEmojis }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/adapters/auth/session-actor.server"),
        import("@/application/emojis/emojis.server"),
      ])
    return listEmojis(await requireSessionActor(getRequest()))
  }
)
export const uploadCustomEmoji = createServerFn({ method: "POST" })
  .validator(customEmojiInputSchema)
  .handler(async ({ data }) => {
    const [{ getRequest }, { requireSessionActor }, { addEmoji }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/adapters/auth/session-actor.server"),
        import("@/application/emojis/emojis.server"),
      ])
    return addEmoji(await requireSessionActor(getRequest()), data)
  })
export const removeCustomEmoji = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }).strict())
  .handler(async ({ data }) => {
    const [{ getRequest }, { requireSessionActor }, { removeEmoji }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/adapters/auth/session-actor.server"),
        import("@/application/emojis/emojis.server"),
      ])
    return removeEmoji(await requireSessionActor(getRequest()), data.id)
  })
