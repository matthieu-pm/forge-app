import "@tanstack/react-start/server-only"

import { and, asc, eq, isNull } from "drizzle-orm"

import type {
  CreateTeamInput,
  CreateTeamResult,
  DeleteTeamInput,
  DeleteTeamResult,
  TeamRouteState,
  TeamSummary,
  UpdateTeamInput,
  UpdateTeamResult,
} from "@/lib/team-contract"
import { db, teams } from "@/db"
import {
  WorkspaceAccessError,
  requireActiveWorkspaceMember,
} from "@/lib/auth-server"
import { slugifyTeamName } from "@/lib/team-contract"

function canManageTeams(role: string) {
  return role
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "owner" || value === "admin")
}

function toTeamSummary(team: typeof teams.$inferSelect): TeamSummary {
  return {
    id: team.id,
    slug: team.slug,
    identifier: team.identifier,
    name: team.name,
    icon: {
      kind: team.iconKind as "icon" | "emoji",
      value: team.iconValue,
      color: team.color,
    },
    timezone: team.timezone,
    description: team.description,
    estimationScheme: team.estimationScheme as TeamSummary["estimationScheme"],
    issueEmailEnabled: team.issueEmailEnabled,
    detailedHistoryEnabled: team.detailedHistoryEnabled,
  }
}

function accessErrorResult(error: WorkspaceAccessError): CreateTeamResult {
  const messages = {
    UNAUTHENTICATED: "Sign in before creating a team.",
    NO_ACTIVE_WORKSPACE: "Choose a workspace before creating a team.",
    FORBIDDEN: "You do not have access to this workspace.",
  } as const

  return {
    ok: false,
    code: error.code,
    message: messages[error.code],
  }
}

function constraintName(error: unknown) {
  const visited = new Set<object>()
  const values: Array<string> = []
  let candidate = error

  while (
    candidate &&
    typeof candidate === "object" &&
    !visited.has(candidate)
  ) {
    visited.add(candidate)
    const current = candidate as {
      cause?: unknown
      constraint?: unknown
      message?: unknown
    }

    if (typeof current.constraint === "string") {
      values.push(current.constraint)
    }

    if (typeof current.message === "string") {
      values.push(current.message)
    }

    candidate = current.cause
  }

  return values.join(" ")
}

export async function createTeamForRequest(
  request: Request,
  input: CreateTeamInput
): Promise<CreateTeamResult> {
  let actor

  try {
    actor = await requireActiveWorkspaceMember(request)
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      return accessErrorResult(error)
    }

    throw error
  }

  if (!canManageTeams(actor.role)) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Only workspace owners and admins can create teams.",
    }
  }

  const slug = slugifyTeamName(input.name)

  if (!slug) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      field: "name",
      message: "Use at least one letter or number in the team name.",
    }
  }

  try {
    const createdTeams = await db
      .insert(teams)
      .values({
        workspaceId: actor.workspace.id,
        slug,
        identifier: input.identifier,
        name: input.name,
        iconKind: input.icon.kind,
        iconValue: input.icon.value,
        color: input.icon.color,
        timezone: input.timezone,
        createdByUserId: actor.userId,
      })
      .returning()
    const createdTeam = createdTeams.at(0)

    if (!createdTeam) {
      return {
        ok: false,
        code: "UNKNOWN",
        message: "The team could not be created.",
      }
    }

    return { ok: true, team: toTeamSummary(createdTeam) }
  } catch (error) {
    const constraint = constraintName(error)

    if (constraint.includes("teams_workspace_slug_unique")) {
      return {
        ok: false,
        code: "SLUG_TAKEN",
        field: "name",
        message: "A team with this name already exists in the workspace.",
      }
    }

    if (constraint.includes("teams_workspace_identifier_unique")) {
      return {
        ok: false,
        code: "IDENTIFIER_TAKEN",
        field: "identifier",
        message: "This identifier is already used by another team.",
      }
    }

    throw error
  }
}

export async function listTeamsForRequest(
  request: Request
): Promise<Array<TeamSummary>> {
  const actor = await requireActiveWorkspaceMember(request)
  const workspaceTeams = await db
    .select()
    .from(teams)
    .where(
      and(eq(teams.workspaceId, actor.workspace.id), isNull(teams.deletedAt))
    )
    .orderBy(asc(teams.name))

  return workspaceTeams.map(toTeamSummary)
}

export async function getTeamForRequest(
  request: Request,
  slug: string
): Promise<TeamSummary | null> {
  const actor = await requireActiveWorkspaceMember(request)
  return findTeamInWorkspace(actor.workspace.id, slug)
}

async function findTeamInWorkspace(workspaceId: string, slug: string) {
  const matchingTeams = await db
    .select()
    .from(teams)
    .where(
      and(
        eq(teams.workspaceId, workspaceId),
        eq(teams.slug, slug),
        isNull(teams.deletedAt)
      )
    )
    .limit(1)
  const team = matchingTeams.at(0)

  return team ? toTeamSummary(team) : null
}

export async function getTeamRouteStateForRequest(
  request: Request,
  slug: string
): Promise<TeamRouteState> {
  let actor

  try {
    actor = await requireActiveWorkspaceMember(request)
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

  const team = await findTeamInWorkspace(actor.workspace.id, slug)

  return team ? { status: "ready", team } : { status: "not-found" }
}

export async function deleteTeamForRequest(
  request: Request,
  input: DeleteTeamInput
): Promise<DeleteTeamResult> {
  let actor

  try {
    actor = await requireActiveWorkspaceMember(request)
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      const messages = {
        UNAUTHENTICATED: "Sign in before deleting a team.",
        NO_ACTIVE_WORKSPACE: "Choose a workspace before deleting a team.",
        FORBIDDEN: "You do not have access to this workspace.",
      } as const

      return {
        ok: false,
        code: error.code,
        message: messages[error.code],
      }
    }

    throw error
  }

  if (!canManageTeams(actor.role)) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Only workspace owners and admins can delete teams.",
    }
  }

  const deletedAt = new Date()
  const deletedTeams = await db
    .update(teams)
    .set({ deletedAt, updatedAt: deletedAt })
    .where(
      and(
        eq(teams.workspaceId, actor.workspace.id),
        eq(teams.slug, input.slug),
        eq(teams.name, input.confirmationName),
        isNull(teams.deletedAt)
      )
    )
    .returning({ name: teams.name, slug: teams.slug })
  const deletedTeam = deletedTeams.at(0)

  if (!deletedTeam) {
    return {
      ok: false,
      code: "TEAM_NOT_FOUND_OR_NAME_MISMATCH",
      message: "The team name did not match, or the team no longer exists.",
    }
  }

  const recoverableUntil = new Date(deletedAt)
  recoverableUntil.setUTCDate(recoverableUntil.getUTCDate() + 30)

  return {
    ok: true,
    team: deletedTeam,
    recoverableUntil: recoverableUntil.toISOString(),
  }
}

export async function updateTeamForRequest(
  request: Request,
  input: UpdateTeamInput
): Promise<UpdateTeamResult> {
  let actor

  try {
    actor = await requireActiveWorkspaceMember(request)
  } catch (error) {
    if (error instanceof WorkspaceAccessError) {
      const messages = {
        UNAUTHENTICATED: "Sign in before updating a team.",
        NO_ACTIVE_WORKSPACE: "Choose a workspace before updating a team.",
        FORBIDDEN: "You do not have access to this workspace.",
      } as const

      return { ok: false, code: error.code, message: messages[error.code] }
    }

    throw error
  }

  if (!canManageTeams(actor.role)) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Only workspace owners and admins can update teams.",
    }
  }

  try {
    const updatedTeams = await db
      .update(teams)
      .set({ ...input.settings, updatedAt: new Date() })
      .where(
        and(
          eq(teams.workspaceId, actor.workspace.id),
          eq(teams.slug, input.slug),
          isNull(teams.deletedAt)
        )
      )
      .returning()
    const updatedTeam = updatedTeams.at(0)

    if (!updatedTeam) {
      return {
        ok: false,
        code: "TEAM_NOT_FOUND",
        message: "The team no longer exists.",
      }
    }

    return { ok: true, team: toTeamSummary(updatedTeam) }
  } catch (error) {
    if (constraintName(error).includes("teams_workspace_identifier_unique")) {
      return {
        ok: false,
        code: "IDENTIFIER_TAKEN",
        field: "identifier",
        message: "This identifier is already used by another team.",
      }
    }

    throw error
  }
}
