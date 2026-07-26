import "@tanstack/react-start/server-only"

import type {
  CreateTeamInput,
  CreateTeamResult,
  DeleteTeamInput,
  DeleteTeamResult,
  LeaveTeamResult,
  RestoreTeamResult,
  TeamDirectory,
  TeamLifecycle,
  TeamMutationInput,
  TeamRouteState,
  TeamSummary,
  UpdateTeamInput,
  UpdateTeamResult,
} from "@/lib/team-contract"
import {
  archiveTeam,
  createTeam,
  getTeam,
  getTeamDirectory,
  leaveTeam,
  listTeams,
  restoreTeam,
  updateTeam,
} from "@/application/teams/teams.server"
import { requireSessionActor } from "@/adapters/auth/session-actor.server"
import { WorkspaceAccessError } from "@/lib/auth-server"

function accessResult(error: WorkspaceAccessError, action: string) {
  const messages = {
    UNAUTHENTICATED: `Sign in before ${action} a team.`,
    NO_ACTIVE_WORKSPACE: `Choose a workspace before ${action} a team.`,
    FORBIDDEN: "You do not have access to this workspace.",
  } as const

  return { ok: false as const, code: error.code, message: messages[error.code] }
}

export async function createTeamForRequest(
  request: Request,
  input: CreateTeamInput
): Promise<CreateTeamResult> {
  try {
    return createTeam(await requireSessionActor(request), input)
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return accessResult(error, "creating")
    }

    throw error
  }
}

export async function listTeamsForRequest(
  request: Request
): Promise<Array<TeamSummary>> {
  const actor = await requireSessionActor(request)
  const items: Array<TeamSummary> = []
  let cursor: string | undefined

  do {
    const page = await listTeams(actor, { cursor })
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)

  return items
}

export async function getTeamDirectoryForRequest(
  request: Request,
  lifecycle: TeamLifecycle
): Promise<TeamDirectory> {
  return getTeamDirectory(await requireSessionActor(request), lifecycle)
}

export async function getTeamForRequest(
  request: Request,
  slug: string
): Promise<TeamSummary | null> {
  return getTeam(await requireSessionActor(request), { slug })
}

export async function getTeamRouteStateForRequest(
  request: Request,
  slug: string
): Promise<TeamRouteState> {
  try {
    const team = await getTeam(await requireSessionActor(request), { slug })
    return team ? { status: "ready", team } : { status: "not-found" }
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      const statuses = {
        UNAUTHENTICATED: "unauthenticated",
        NO_ACTIVE_WORKSPACE: "no-workspace",
        FORBIDDEN: "forbidden",
      } as const

      return { status: statuses[error.code] }
    }

    throw error
  }
}

export async function deleteTeamForRequest(
  request: Request,
  input: DeleteTeamInput
): Promise<DeleteTeamResult> {
  try {
    return archiveTeam(
      await requireSessionActor(request),
      { slug: input.slug },
      input.confirmationName
    )
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return accessResult(error, "deleting")
    }

    throw error
  }
}

export async function restoreTeamForRequest(
  request: Request,
  input: TeamMutationInput
): Promise<RestoreTeamResult> {
  try {
    return restoreTeam(await requireSessionActor(request), {
      slug: input.slug,
    })
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return accessResult(error, "restoring")
    }

    throw error
  }
}

export async function leaveTeamForRequest(
  request: Request,
  input: TeamMutationInput
): Promise<LeaveTeamResult> {
  try {
    return leaveTeam(await requireSessionActor(request), {
      slug: input.slug,
    })
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return accessResult(error, "leaving")
    }

    throw error
  }
}

export async function updateTeamForRequest(
  request: Request,
  input: UpdateTeamInput
): Promise<UpdateTeamResult> {
  try {
    return updateTeam(
      await requireSessionActor(request),
      { slug: input.slug },
      input.settings
    )
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return accessResult(error, "updating")
    }

    throw error
  }
}
