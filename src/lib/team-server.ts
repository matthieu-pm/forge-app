import "@tanstack/react-start/server-only"

import { and, asc, eq } from "drizzle-orm"

import type {
  CreateTeamInput,
  CreateTeamResult,
  TeamSummary,
} from "@/lib/team-contract"
import { db, teams } from "@/db"
import {
  WorkspaceAccessError,
  requireActiveWorkspaceMember,
} from "@/lib/auth-server"
import { slugifyTeamName } from "@/lib/team-contract"

function canCreateTeam(role: string) {
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
  if (!error || typeof error !== "object") {
    return ""
  }

  const candidate = error as { constraint?: unknown; message?: unknown }
  return [candidate.constraint, candidate.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
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

  if (!canCreateTeam(actor.role)) {
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
    .where(eq(teams.workspaceId, actor.workspace.id))
    .orderBy(asc(teams.name))

  return workspaceTeams.map(toTeamSummary)
}

export async function getTeamForRequest(
  request: Request,
  slug: string
): Promise<TeamSummary | null> {
  const actor = await requireActiveWorkspaceMember(request)
  const matchingTeams = await db
    .select()
    .from(teams)
    .where(and(eq(teams.workspaceId, actor.workspace.id), eq(teams.slug, slug)))
    .limit(1)
  const team = matchingTeams.at(0)

  return team ? toTeamSummary(team) : null
}
