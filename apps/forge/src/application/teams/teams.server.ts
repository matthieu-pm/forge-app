import "@tanstack/react-start/server-only"

import { and, asc, eq, gt, isNotNull, isNull, or } from "drizzle-orm"

import type { Actor } from "@/application/actor"
import type {
  CreateTeamInput,
  CreateTeamResult,
  DeleteTeamResult,
  LeaveTeamResult,
  RestoreTeamResult,
  TeamDirectory,
  TeamLifecycle,
  TeamSummary,
  UpdateTeamInput,
  UpdateTeamResult,
} from "@/application/teams/team-schemas"
import {
  canManageTeams,
  hasScope,
  requireTeamRead,
} from "@/application/authorization"
import { slugifyTeamName } from "@/application/teams/team-schemas"
import { visibleTeamCondition } from "@/application/teams/team-visibility.server"
import { canWorkspaceAction } from "@/application/workspace-security/workspace-security.server"
import { db, teamMembers, teams } from "@/db"

export type TeamSelector = { id: string } | { slug: string }
const TEAM_RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000

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
    visibility: team.visibility as TeamSummary["visibility"],
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
  if (
    !hasScope(actor, "teams:write") ||
    !(await canWorkspaceAction(actor, "teams.create"))
  ) {
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
    const createdTeam = await db.transaction(async (transaction) => {
      const createdTeams = await transaction
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
      const team = createdTeams.at(0)

      if (team) {
        await transaction.insert(teamMembers).values({
          workspaceId: actor.workspaceId,
          teamId: team.id,
          userId: actor.userId,
          role: "member",
        })
      }

      return team
    })

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

export async function getTeamDirectory(
  actor: Actor,
  lifecycle: TeamLifecycle
): Promise<TeamDirectory> {
  requireTeamRead(actor)

  const recoveryCutoff = new Date(Date.now() - TEAM_RECOVERY_WINDOW_MS)
  const workspaceTeams = await db.query.teams.findMany({
    where: and(
      visibleTeamCondition(actor),
      lifecycle === "active"
        ? isNull(teams.deletedAt)
        : and(isNotNull(teams.deletedAt), gt(teams.deletedAt, recoveryCutoff))
    ),
    orderBy: [asc(teams.name), asc(teams.id)],
    with: {
      members: {
        with: { user: true },
      },
    },
  })
  const canManage = canManageTeams(actor)
  const canCreateTeam =
    hasScope(actor, "teams:write") &&
    (await canWorkspaceAction(actor, "teams.create"))
  return {
    canCreateTeam,
    items: workspaceTeams.map((team) => {
      const currentMembership = team.members.find(
        (member) => member.userId === actor.userId
      )
      const leadCount = team.members.filter(
        (member) => member.role === "lead"
      ).length
      const deletedAt = team.deletedAt
      const recoverableUntil = deletedAt
        ? new Date(deletedAt.getTime() + TEAM_RECOVERY_WINDOW_MS)
        : null

      const memberDetails = (member: (typeof team.members)[number]) => ({
        id: member.user.id,
        name: member.user.name,
        username:
          member.user.username ??
          member.user.email
            .split("@", 1)[0]
            .toLocaleLowerCase()
            .replace(/[^a-z0-9_-]/g, "")
            .slice(0, 32),
        image: member.user.image,
      })
      return {
        ...toTeamSummary(team),
        lifecycle,
        isMember: Boolean(currentMembership),
        memberCount: team.members.length,
        directoryMembers: team.members.map(memberDetails),
        owners: team.members
          .filter((member) => member.role === "lead")
          .map(memberDetails),
        updatedAt: team.updatedAt.toISOString(),
        memberPreviews: [...team.members]
          .sort(
            (left, right) =>
              left.createdAt.getTime() - right.createdAt.getTime()
          )
          .slice(0, 5)
          .map(memberDetails),
        issueCount: null,
        recoverableUntil: recoverableUntil?.toISOString() ?? null,
        capabilities: {
          canOpenSettings: lifecycle === "active",
          canLeave:
            lifecycle === "active" &&
            Boolean(currentMembership) &&
            (currentMembership?.role !== "lead" || leadCount > 1),
          canDelete: lifecycle === "active" && canManage,
          canRestore:
            lifecycle === "archived" &&
            canManage &&
            Boolean(recoverableUntil && recoverableUntil > new Date()),
        },
      }
    }),
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
        visibleTeamCondition(actor),
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

export async function restoreTeam(
  actor: Actor,
  selector: TeamSelector
): Promise<RestoreTeamResult> {
  if (!canManageTeams(actor)) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Only workspace owners and admins can restore teams.",
    }
  }

  try {
    const recoveryCutoff = new Date(Date.now() - TEAM_RECOVERY_WINDOW_MS)
    const restoredTeams = await db
      .update(teams)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(teams.workspaceId, actor.workspaceId),
          selectorCondition(selector),
          isNotNull(teams.deletedAt),
          gt(teams.deletedAt, recoveryCutoff)
        )
      )
      .returning()
    const restoredTeam = restoredTeams.at(0)

    if (!restoredTeam) {
      return {
        ok: false,
        code: "TEAM_NOT_FOUND",
        message: "The archived team no longer exists.",
      }
    }

    return { ok: true, team: toTeamSummary(restoredTeam) }
  } catch (error) {
    const constraint = constraintName(error)

    if (
      constraint.includes("teams_workspace_slug_unique") ||
      constraint.includes("teams_workspace_identifier_unique")
    ) {
      return {
        ok: false,
        code: "RESTORE_CONFLICT",
        message:
          "Another active team now uses this name or identifier. Rename that team before restoring this one.",
      }
    }

    throw error
  }
}

export async function joinTeam(
  actor: Actor,
  selector: TeamSelector
): Promise<
  | { ok: true; team: { name: string; slug: string } }
  | { ok: false; message: string }
> {
  requireTeamRead(actor)
  if (!hasScope(actor, "teams:write"))
    return {
      ok: false,
      message: "The credential cannot change team memberships.",
    }
  const team = await db.query.teams.findFirst({
    where: and(
      eq(teams.workspaceId, actor.workspaceId),
      selectorCondition(selector),
      isNull(teams.deletedAt)
    ),
    with: { members: true },
  })
  if (!team) return { ok: false, message: "The team no longer exists." }
  if (team.members.some((member) => member.userId === actor.userId))
    return { ok: true, team: { name: team.name, slug: team.slug } }
  if (team.visibility === "private" && !canManageTeams(actor))
    return {
      ok: false,
      message: "Ask a workspace admin to add you to this private team.",
    }
  await db
    .insert(teamMembers)
    .values({
      workspaceId: actor.workspaceId,
      teamId: team.id,
      userId: actor.userId,
      role: "member",
    })
    .onConflictDoNothing({ target: [teamMembers.teamId, teamMembers.userId] })
  return { ok: true, team: { name: team.name, slug: team.slug } }
}

export async function leaveTeam(
  actor: Actor,
  selector: TeamSelector
): Promise<LeaveTeamResult> {
  requireTeamRead(actor)
  if (!hasScope(actor, "teams:write")) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "The credential cannot change team memberships.",
    }
  }

  const team = await db.query.teams.findFirst({
    where: and(
      eq(teams.workspaceId, actor.workspaceId),
      selectorCondition(selector),
      isNull(teams.deletedAt)
    ),
    with: { members: true },
  })

  if (!team) {
    return {
      ok: false,
      code: "TEAM_NOT_FOUND",
      message: "The team no longer exists.",
    }
  }

  const membership = team.members.find(
    (member) => member.userId === actor.userId
  )

  if (!membership) {
    return {
      ok: false,
      code: "NOT_A_MEMBER",
      message: "You are not a member of this team.",
    }
  }

  if (
    membership.role === "lead" &&
    team.members.filter((member) => member.role === "lead").length === 1
  ) {
    return {
      ok: false,
      code: "LAST_LEAD",
      message: "Assign another team lead before leaving this team.",
    }
  }

  await db
    .delete(teamMembers)
    .where(
      and(
        eq(teamMembers.workspaceId, actor.workspaceId),
        eq(teamMembers.teamId, team.id),
        eq(teamMembers.userId, actor.userId)
      )
    )

  return { ok: true, team: { name: team.name, slug: team.slug } }
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
        isNull(teams.deletedAt),
        visibleTeamCondition(actor)
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

  const recoverableUntil = new Date(
    deletedAt.getTime() + TEAM_RECOVERY_WINDOW_MS
  )

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
