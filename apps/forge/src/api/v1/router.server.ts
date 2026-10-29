import "@tanstack/react-start/server-only"

import { implement } from "@orpc/server"

import type { PublicApiInitialContext } from "@/api/v1/context"
import { ApplicationAccessError } from "@/application/authorization"
import {
  InvalidTeamCursorError,
  archiveTeam,
  createTeam,
  getTeam,
  listTeams,
  updateTeam,
} from "@/application/teams/teams.server"
import { publicApiContract } from "@/api/v1/contract"
import { writeApiAuditEvent } from "@/api/v1/audit.server"
import {
  IdempotencyConflictError,
  executeIdempotent,
} from "@/api/v1/idempotency.server"
import { teamSummarySchema } from "@/application/teams/team-schemas"
import {
  ApiCredentialError,
  requireApiKeyActor,
} from "@/adapters/auth/api-key-actor.server"

const os = implement(publicApiContract).$context<PublicApiInitialContext>()

const requireApiActor = os.middleware(async ({ context, next, errors }) => {
  try {
    const actor = await requireApiKeyActor(context.headers)
    return next({ context: { actor } })
  } catch (error) {
    if (error instanceof ApiCredentialError) {
      if (error.code === "RATE_LIMITED") {
        throw errors.RATE_LIMITED({ message: error.message })
      }
      if (error.code === "FORBIDDEN") {
        throw errors.FORBIDDEN({ message: error.message })
      }
      throw errors.UNAUTHORIZED({ message: error.message })
    }

    throw error
  }
})

const api = os.use(requireApiActor)

const list = api.teams.list.handler(async ({ context, input, errors }) => {
  try {
    return await listTeams(context.actor, input)
  } catch (error) {
    if (error instanceof InvalidTeamCursorError) {
      throw errors.BAD_REQUEST({ message: error.message })
    }
    if (error instanceof ApplicationAccessError) {
      throw errors.FORBIDDEN({ message: error.message })
    }
    throw error
  }
})

const get = api.teams.get.handler(async ({ context, input, errors }) => {
  try {
    const team = await getTeam(context.actor, { id: input.teamId })
    if (!team) throw errors.NOT_FOUND()
    return team
  } catch (error) {
    if (error instanceof ApplicationAccessError) {
      throw errors.FORBIDDEN({ message: error.message })
    }
    throw error
  }
})

const create = api.teams.create.handler(async ({ context, input, errors }) => {
  const idempotencyKey = context.headers.get("idempotency-key")?.trim()
  if (
    !idempotencyKey ||
    idempotencyKey.length > 255 ||
    /[^\x20-\x7e]/.test(idempotencyKey)
  ) {
    throw errors.BAD_REQUEST({
      message: "Provide an Idempotency-Key header of at most 255 characters.",
    })
  }

  try {
    const execution = await executeIdempotent({
      actor: context.actor,
      idempotencyKey,
      input,
      operationId: "createTeam",
      status: 201,
      parse: (value) => teamSummarySchema.parse(value),
      run: async () => {
        const result = await createTeam(context.actor, input)

        if (result.ok) return result.team
        if (result.code === "FORBIDDEN") {
          throw errors.FORBIDDEN({ message: result.message })
        }
        if (
          result.code === "SLUG_TAKEN" ||
          result.code === "IDENTIFIER_TAKEN" ||
          result.code === "TEAM_LIMIT"
        ) {
          throw errors.CONFLICT({
            message: result.message,
            data: { reason: result.code, field: result.field },
          })
        }
        if (result.code === "INVALID_INPUT") {
          throw errors.BAD_REQUEST({ message: result.message })
        }

        throw new Error(result.message)
      },
    })

    writeApiAuditEvent({
      actor: context.actor,
      operation: "createTeam",
      outcome: execution.replayed ? "replayed" : "succeeded",
      requestId: context.requestId,
      resourceId: execution.value.id,
    })
    return execution.value
  } catch (error) {
    writeApiAuditEvent({
      actor: context.actor,
      operation: "createTeam",
      outcome: "rejected",
      requestId: context.requestId,
    })
    if (error instanceof IdempotencyConflictError) {
      throw errors.CONFLICT({
        message: error.message,
        data: { reason: "IDEMPOTENCY_KEY_REUSED" },
      })
    }
    throw error
  }
})

const update = api.teams.update.handler(async ({ context, input, errors }) => {
  const result = await updateTeam(
    context.actor,
    { id: input.teamId },
    input.settings
  )

  if (result.ok) {
    writeApiAuditEvent({
      actor: context.actor,
      operation: "updateTeam",
      outcome: "succeeded",
      requestId: context.requestId,
      resourceId: result.team.id,
    })
    return result.team
  }
  writeApiAuditEvent({
    actor: context.actor,
    operation: "updateTeam",
    outcome: "rejected",
    requestId: context.requestId,
    resourceId: input.teamId,
  })
  if (result.code === "FORBIDDEN") {
    throw errors.FORBIDDEN({ message: result.message })
  }
  if (result.code === "TEAM_NOT_FOUND") throw errors.NOT_FOUND()
  if (result.code === "IDENTIFIER_TAKEN") {
    throw errors.CONFLICT({
      message: result.message,
      data: { reason: result.code, field: result.field },
    })
  }

  throw new Error(result.message)
})

const archive = api.teams.archive.handler(
  async ({ context, input, errors }) => {
    const result = await archiveTeam(context.actor, { id: input.teamId })

    if (result.ok) {
      writeApiAuditEvent({
        actor: context.actor,
        operation: "archiveTeam",
        outcome: "succeeded",
        requestId: context.requestId,
        resourceId: input.teamId,
      })
      return result
    }
    writeApiAuditEvent({
      actor: context.actor,
      operation: "archiveTeam",
      outcome: "rejected",
      requestId: context.requestId,
      resourceId: input.teamId,
    })
    if (result.code === "FORBIDDEN") {
      throw errors.FORBIDDEN({ message: result.message })
    }
    if (result.code === "TEAM_NOT_FOUND_OR_NAME_MISMATCH") {
      throw errors.NOT_FOUND()
    }

    throw new Error(result.message)
  }
)

export const publicApiRouter = os.router({
  teams: { list, get, create, update, archive },
})
