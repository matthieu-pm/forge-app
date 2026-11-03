import { createServerFn } from "@tanstack/react-start"
import { teamMutationInputSchema } from "@/lib/team-contract"

export const loadTeamThreadSummariesAccess = createServerFn({ method: "GET" })
  .validator(teamMutationInputSchema)
  .handler(async ({ data }) => {
    const [
      { getRequest: request },
      { requireSessionActor },
      { requireFeatureWrite },
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/features/features.server"),
    ])
    requireFeatureWrite(await requireSessionActor(request()), "threadSummaries")
    const [{ getRequest }, { getTeamThreadSummariesAccess }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/lib/team-thread-summaries-server"),
      ])
    return getTeamThreadSummariesAccess(getRequest(), data.slug)
  })
