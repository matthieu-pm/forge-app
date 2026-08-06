import { createServerFn } from "@tanstack/react-start"

import {
  createTeamInputSchema,
  deleteTeamInputSchema,
  teamLifecycleSchema,
  teamMutationInputSchema,
  updateTeamInputSchema,
} from "@/lib/team-contract"

export const createTeam = createServerFn({ method: "POST" })
  .validator(createTeamInputSchema)
  .handler(async ({ data }) => {
    const [{ getRequest }, { createTeamForRequest }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/lib/team-server"),
    ])

    return createTeamForRequest(getRequest(), data)
  })

export const loadTeams = createServerFn({ method: "GET" }).handler(async () => {
  const [{ getRequest }, { listTeamsForRequest }] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("@/lib/team-server"),
  ])

  return listTeamsForRequest(getRequest())
})

export const loadTeamDirectory = createServerFn({ method: "GET" })
  .validator(teamLifecycleSchema)
  .handler(async ({ data }) => {
    const [{ getRequest }, { getTeamDirectoryForRequest }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/lib/team-server"),
    ])

    return getTeamDirectoryForRequest(getRequest(), data)
  })

type TeamList = Awaited<ReturnType<typeof loadTeams>>

let pendingClientTeamList: Promise<TeamList> | undefined

export function listTeams(): Promise<TeamList> {
  if (typeof window === "undefined") {
    return loadTeams()
  }

  if (pendingClientTeamList) {
    return pendingClientTeamList
  }

  const request = loadTeams().finally(() => {
    if (pendingClientTeamList === request) {
      pendingClientTeamList = undefined
    }
  })
  pendingClientTeamList = request
  return request
}

export const getTeam = createServerFn({ method: "GET" })
  .validator((input: { slug: string }) => ({
    slug: input.slug.trim().toLowerCase(),
  }))
  .handler(async ({ data }) => {
    const [{ getRequest }, { getTeamForRequest }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/lib/team-server"),
    ])

    return getTeamForRequest(getRequest(), data.slug)
  })

export const getTeamRouteState = createServerFn({ method: "GET" })
  .validator((input: { slug: string }) => ({
    slug: input.slug.trim().toLowerCase(),
  }))
  .handler(async ({ data }) => {
    const [{ getRequest }, { getTeamRouteStateForRequest }] = await Promise.all(
      [import("@tanstack/react-start/server"), import("@/lib/team-server")]
    )

    return getTeamRouteStateForRequest(getRequest(), data.slug)
  })

export const deleteTeam = createServerFn({ method: "POST" })
  .validator(deleteTeamInputSchema)
  .handler(async ({ data }) => {
    const [{ getRequest }, { deleteTeamForRequest }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/lib/team-server"),
    ])

    return deleteTeamForRequest(getRequest(), data)
  })

export const restoreTeam = createServerFn({ method: "POST" })
  .validator(teamMutationInputSchema)
  .handler(async ({ data }) => {
    const [{ getRequest }, { restoreTeamForRequest }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/lib/team-server"),
    ])

    return restoreTeamForRequest(getRequest(), data)
  })

export const leaveTeam = createServerFn({ method: "POST" })
  .validator(teamMutationInputSchema)
  .handler(async ({ data }) => {
    const [{ getRequest }, { leaveTeamForRequest }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/lib/team-server"),
    ])

    return leaveTeamForRequest(getRequest(), data)
  })

export const updateTeam = createServerFn({ method: "POST" })
  .validator(updateTeamInputSchema)
  .handler(async ({ data }) => {
    const [{ getRequest }, { updateTeamForRequest }] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/lib/team-server"),
    ])

    return updateTeamForRequest(getRequest(), data)
  })
