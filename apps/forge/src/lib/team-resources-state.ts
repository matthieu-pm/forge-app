import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import { teamResourceCommandSchema } from "./team-resources-contract"

const binding = z.object({
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
})
async function context(data: z.infer<typeof binding>) {
  const [{ getRequest, setResponseHeader }, { requireSessionActor }] =
    await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
    ])
  setResponseHeader("Cache-Control", "private, no-store")
  const actor = await requireSessionActor(getRequest())
  if (
    actor.workspaceId !== data.workspaceId ||
    actor.authentication.kind !== "session" ||
    actor.authentication.sessionId !== data.sessionId
  )
    throw new Error("The active session changed. Reload before continuing.")
  return actor
}
export const loadTeamResources = createServerFn({ method: "GET" })
  .validator(binding.extend({ teamId: z.uuid() }))
  .handler(async ({ data }) => {
    const actor = await context(data)
    const { readTeamResources } =
      await import("@/application/resources/team-resources.server")
    return JSON.stringify(await readTeamResources(actor, data.teamId))
  })
export const persistTeamResources = createServerFn({ method: "POST" })
  .validator(
    binding.extend({ commandKey: z.uuid(), command: teamResourceCommandSchema })
  )
  .handler(async ({ data }) => {
    const actor = await context(data)
    const { commandTeamResources } =
      await import("@/application/resources/team-resources.server")
    return JSON.stringify(
      await commandTeamResources(actor, data.commandKey, data.command)
    )
  })
