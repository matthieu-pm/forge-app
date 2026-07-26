import "@tanstack/react-start/server-only"

import { and, asc, eq, gt, isNull, or } from "drizzle-orm"

import type { Actor } from "@/application/actor"
import type {
  CreateTeamInput,
  CreateTeamResult,
  DeleteTeamResult,
  TeamSummary,
  UpdateTeamInput,
  UpdateTeamResult,
} from "@/application/teams/team-schemas"
import { canManageTeams, requireTeamRead } from "@/application/authorization"
import { slugifyTeamName } from "@/application/teams/team-schemas"
import { db, teams } from "@/db"

export type TeamSelector = { id: string } | { slug: string }

export type ListTeamsInput = {
  cursor?: string
  limit?: number
}

export type TeamPage = {
  items: Array<TeamSummary>
  nextCursor: string | null
}

export class InvalidTeamCursorError extends Error {
  constructor() {
    super("The team cursor is invalid.")
    this.name = "InvalidTeamCursorError"
  }
}

type TeamCursor = { id: string; name: string }

export function toTeamSummary(team: typeof teams.$inferSelect): TeamSummary {
  return {
    id: team.id,
    slug: team.slug,
    identifier: team.identifier,
    name: team.name,
    icon: {
      kind: team.iconKind as "icon" | "emoji",
      value: team.iconValue,
      color: team.color as TeamSummary["icon"]["color"],
    },
    timezone: team.timezone,
    description: team.description,
    estimationScheme: team.estimationScheme as TeamSummary["estimationScheme"],
    issueEmailEnabled: team.issueEmailEnabled,
    detailedHistoryEnabled: team.detailedHistoryEnabled,
    createdAt: team.createdAt.toISOString(),
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

function selectorCondition(selector: TeamSelector) {
  return "id" in selector
    ? eq(teams.id, selector.id)
    : eq(teams.slug, selector.slug)
}

function encodeCursor(cursor: TeamCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

function decodeCursor(value: string): TeamCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as unknown

    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as TeamCursor).id === "string" &&
      typeof (parsed as TeamCursor).name === "string"
    ) {
      return parsed as TeamCursor
    }
  } catch {
    // The caller turns this into a typed invalid-cursor response.
  }

  return null
}

export async function createTeam(
  actor: Actor,
  input: CreateTeamInput
): Promise<CreateTeamResult> {
  if (!canManageTeams(actor)) {
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
        workspaceId: actor.workspaceId,
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

export async function listTeams(
  actor: Actor,
  input: ListTeamsInput = {}
): Promise<TeamPage> {
  requireTeamRead(actor)

  const limit = Math.max(1, Math.min(input.limit ?? 100, 100))
  const cursor = input.cursor ? decodeCursor(input.cursor) : null
  if (input.cursor && !cursor) throw new InvalidTeamCursorError()
  const cursorCondition = cursor
    ? or(
        gt(teams.name, cursor.name),
        and(eq(teams.name, cursor.name), gt(teams.id, cursor.id))
      )
    : undefined
  const workspaceTeams = await db
    .select()
    .from(teams)
    .where(
      and(
        eq(teams.workspaceId, actor.workspaceId),
        isNull(teams.deletedAt),
        cursorCondition
      )
    )
    .orderBy(asc(teams.name), asc(teams.id))
    .limit(limit + 1)

  const hasMore = workspaceTeams.length > limit
  const pageTeams = workspaceTeams.slice(0, limit)
  const lastTeam = pageTeams.at(-1)

  return {
    items: pageTeams.map(toTeamSummary),
    nextCursor:
      hasMore && lastTeam
        ? encodeCursor({ id: lastTeam.id, name: lastTeam.name })
        : null,
  }
}

export async function getTeam(
  actor: Actor,
  selector: TeamSelector
): Promise<TeamSummary | null> {
  requireTeamRead(actor)

  const matchingTeams = await db
    .select()
    .from(teams)
    .where(
      and(
        eq(teams.workspaceId, actor.workspaceId),
        selectorCondition(selector),
        isNull(teams.deletedAt)
      )
    )
    .limit(1)
  const team = matchingTeams.at(0)

  return team ? toTeamSummary(team) : null
}

export async function archiveTeam(
  actor: Actor,
  selector: TeamSelector,
  confirmationName?: string
): Promise<DeleteTeamResult> {
  if (!canManageTeams(actor)) {
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
        eq(teams.workspaceId, actor.workspaceId),
        selectorCondition(selector),
        confirmationName ? eq(teams.name, confirmationName) : undefined,
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

export async function updateTeam(
  actor: Actor,
  selector: TeamSelector,
  settings: UpdateTeamInput["settings"]
): Promise<UpdateTeamResult> {
  if (!canManageTeams(actor)) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Only workspace owners and admins can update teams.",
    }
  }

  try {
    const { icon, ...teamSettings } = settings
    const updatedTeams = await db
      .update(teams)
      .set({
        ...teamSettings,
        ...(icon
          ? {
              iconKind: icon.kind,
              iconValue: icon.value,
              color: icon.color,
            }
          : undefined),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(teams.workspaceId, actor.workspaceId),
          selectorCondition(selector),
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
