import { createServerFn } from "@tanstack/react-start"

import { createTeamInputSchema } from "@/lib/team-contract"

export const createTeam = createServerFn({ method: "POST" })
  .inputValidator(createTeamInputSchema)
  .handler(async ({ data }) => {
    const [{ getRequest }, { createTeamForRequest }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/lib/team-server"),
    ])

    return createTeamForRequest(getRequest(), data)
  })

export const listTeams = createServerFn({ method: "GET" }).handler(async () => {
  const [{ getRequest }, { listTeamsForRequest }] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("@/lib/team-server"),
  ])

  return listTeamsForRequest(getRequest())
})

export const getTeam = createServerFn({ method: "GET" })
  .inputValidator((input: { slug: string }) => ({
    slug: input.slug.trim().toLowerCase(),
  }))
  .handler(async ({ data }) => {
    const [{ getRequest }, { getTeamForRequest }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/lib/team-server"),
    ])

    return getTeamForRequest(getRequest(), data.slug)
  })
