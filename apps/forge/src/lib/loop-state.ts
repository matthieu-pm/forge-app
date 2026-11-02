import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { loopCommandSchema } from "./loop-contract"

const binding = z.object({
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  teamId: z.uuid(),
})
async function actor(data: z.infer<typeof binding>) {
  const [{ getRequest, setResponseHeader }, { requireSessionActor }] =
    await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
    ])
  setResponseHeader("Cache-Control", "private, no-store")
  const current = await requireSessionActor(getRequest())
  if (
    current.workspaceId !== data.workspaceId ||
    current.authentication.kind !== "session" ||
    current.authentication.sessionId !== data.sessionId
  )
    throw Error("The active session changed. Reload before continuing.")
  return current
}
export const loadTeamLoops = createServerFn({ method: "GET" })
  .validator(binding)
  .handler(async ({ data }) => {
    const { readLoops } = await import("@/application/loops/loops.server")
    return JSON.stringify(await readLoops(await actor(data), data.teamId))
  })
export const persistTeamLoop = createServerFn({ method: "POST" })
  .validator(
    binding.extend({ commandKey: z.uuid(), command: loopCommandSchema })
  )
  .handler(async ({ data }) => {
    const { commandLoop } = await import("@/application/loops/loops.server")
    try {
      return JSON.stringify(
        await commandLoop(
          await actor(data),
          data.teamId,
          data.commandKey,
          data.command
        )
      )
    } catch (error) {
      if (
        error instanceof Error &&
        ["ApplicationAccessError", "ZodError", "LoopPolicyError"].includes(
          error.name
        )
      )
        return JSON.stringify({ status: "rejected", message: error.message })
      throw error
    }
  })
