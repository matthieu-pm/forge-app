import { createServerFn } from "@tanstack/react-start"
import {
  addTeamMembersSchema,
  teamMemberQuerySchema,
} from "@/lib/team-member-contract"

export const loadTeamMembers = createServerFn({ method: "GET" })
  .validator(teamMemberQuerySchema)
  .handler(async ({ data }) => {
    const [
      { getRequest },
      { requireSessionActor },
      { getTeamMemberDirectory },
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/teams/team-members.server"),
    ])
    return getTeamMemberDirectory(
      await requireSessionActor(getRequest()),
      data.slug
    )
  })

export const addTeamMembers = createServerFn({ method: "POST" })
  .validator(addTeamMembersSchema)
  .handler(async ({ data }) => {
    const [{ getRequest }, { requireSessionActor }, application] =
      await Promise.all([
        import("@tanstack/react-start/server"),
        import("@/adapters/auth/session-actor.server"),
        import("@/application/teams/team-members.server"),
      ])
    return application.addTeamMembers(
      await requireSessionActor(getRequest()),
      data
    )
  })
