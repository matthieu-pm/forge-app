import { createServerFn } from "@tanstack/react-start"
import { teamMutationInputSchema } from "@/lib/team-contract"

export const loadTeamThreadSummariesAccess = createServerFn({ method: "GET" })
  .validator(teamMutationInputSchema)
  .handler(async ({ data }) => {
    const [{ getRequest }, { getTeamThreadSummariesAccess }] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/lib/team-thread-summaries-server"),
      ])
    return getTeamThreadSummariesAccess(getRequest(), data.slug)
  })
