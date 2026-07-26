import { oc } from "@orpc/contract"
import { z } from "zod"

import {
  createTeamInputSchema,
  teamIdSchema,
  teamSummarySchema,
  updateTeamSettingsSchema,
} from "@/application/teams/team-schemas"

const listTeams = oc
  .route({
    method: "GET",
    path: "/teams",
    operationId: "listTeams",
    summary: "List teams",
  })
  .input(
    z
      .object({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
      .strict()
  )
  .output(
    z
      .object({
        items: z.array(teamSummarySchema),
        nextCursor: z.string().nullable(),
      })
      .strict()
  )

const getTeam = oc
  .route({
    method: "GET",
    path: "/teams/{teamId}",
    operationId: "getTeam",
    summary: "Get a team",
  })
  .input(z.object({ teamId: teamIdSchema }).strict())
  .output(teamSummarySchema)

const createTeam = oc
  .route({
    method: "POST",
    path: "/teams",
    operationId: "createTeam",
    summary: "Create a team",
    successStatus: 201,
  })
  .input(createTeamInputSchema)
  .output(teamSummarySchema)

const updateTeam = oc
  .route({
    method: "PATCH",
    path: "/teams/{teamId}",
    operationId: "updateTeam",
    summary: "Update a team",
  })
  .input(
    z
      .object({
        teamId: teamIdSchema,
        settings: updateTeamSettingsSchema,
      })
      .strict()
  )
  .output(teamSummarySchema)

const archiveTeam = oc
  .route({
    method: "DELETE",
    path: "/teams/{teamId}",
    operationId: "archiveTeam",
    summary: "Archive a team",
  })
  .input(z.object({ teamId: teamIdSchema }).strict())
  .output(
    z
      .object({
        team: teamSummarySchema.pick({ name: true, slug: true }),
        recoverableUntil: z.iso.datetime(),
      })
      .strict()
  )

export const teamsContract = oc.tag("Teams").router({
  list: listTeams,
  get: getTeam,
  create: createTeam,
  update: updateTeam,
  archive: archiveTeam,
})
