import { z } from "zod"
import { createServerFn } from "@tanstack/react-start"

const schema = z
  .object({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    teamId: z.uuid(),
    number: z.number().int().positive().optional(),
  })
  .strict()
export const loadSharedTeamCycles = createServerFn({ method: "GET" })
  .validator(schema)
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      { readTeamCycles },
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/cycles/cycles.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    const actor = await requireSessionActor(getRequest())
    if (
      actor.workspaceId !== data.workspaceId ||
      actor.authentication.kind !== "session" ||
      actor.authentication.sessionId !== data.sessionId
    )
      throw new Error("The active session changed.")
    return readTeamCycles(actor, data.teamId, data.number)
  })
