import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

export const loadPersonDirectory = createServerFn({ method: "GET" })
  .validator(
    z.object({ workspaceId: z.string(), sessionId: z.string() }).strict()
  )
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      service,
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/preferences/person-directory.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    return service.readPersonDirectory(
      await requireSessionActor(getRequest()),
      data
    )
  })
