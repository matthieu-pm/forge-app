import "@tanstack/react-start/server-only"
import { and, desc, eq } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import type {
  RecurringIssueDraft,
  SavedRecurringIssue,
} from "@/lib/recurring-issue-contract"
import { requireCurrentActor } from "@/application/resource-policy.server"
import {
  ApplicationAccessError,
  canManageTeams,
  requireTeamRead,
} from "@/application/authorization"
import { getTeamDirectory } from "@/application/teams/teams.server"
import { db, members, teamRecurringIssues } from "@/db"

async function scope(actor: Actor, slug: string, write = false) {
  requireTeamRead(actor)
  if (write && !canManageTeams(actor))
    throw new ApplicationAccessError(
      "Only workspace owners and admins can manage recurring issues."
    )
  const directory = await getTeamDirectory(actor, "active")
  const team = directory.items.find((item) => item.slug === slug)
  if (!team)
    throw new ApplicationAccessError("You do not have access to this team.")
  return { team, directory }
}
export async function loadRecurringIssues(
  actor: Actor,
  slug: string
): Promise<Array<SavedRecurringIssue>> {
  actor = await requireCurrentActor(actor)
  const { team } = await scope(actor, slug)
  const records = await db
    .select()
    .from(teamRecurringIssues)
    .where(
      and(
        eq(teamRecurringIssues.workspaceId, actor.workspaceId),
        eq(teamRecurringIssues.teamId, team.id)
      )
    )
    .orderBy(desc(teamRecurringIssues.createdAt))
  return records.map((record) => ({
    id: record.id,
    payload: record.payload,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }))
}
export async function saveRecurringIssue(
  actor: Actor,
  input: {
    slug: string
    id?: string
    updatedAt?: string
    payload: RecurringIssueDraft
  }
) {
  actor = await requireCurrentActor(actor)
  const { team, directory } = await scope(actor, input.slug, true)
  const allowedTeams = new Set(directory.items.map((item) => item.id))
  const people = await db.query.members.findMany({
    where: eq(members.organizationId, actor.workspaceId),
  })
  const allowedPeople = new Set(people.map((person) => person.userId))
  const properties = [
    input.payload.properties,
    ...input.payload.subIssues.map((item) => item.properties),
  ]
  if (
    input.payload.properties.teamIds.length !== 1 ||
    input.payload.properties.teamIds[0] !== team.id ||
    properties.some(
      (p) =>
        !p.teamIds.length ||
        p.teamIds.some((id) => !allowedTeams.has(id)) ||
        [p.assignee, p.lead, ...p.members].some(
          (id) => id !== null && !allowedPeople.has(id)
        )
    )
  )
    throw new ApplicationAccessError(
      "Choose teams and members from this workspace."
    )
  const existing = input.id
    ? await db.query.teamRecurringIssues.findFirst({
        where: and(
          eq(teamRecurringIssues.id, input.id),
          eq(teamRecurringIssues.workspaceId, actor.workspaceId),
          eq(teamRecurringIssues.teamId, team.id)
        ),
      })
    : null
  if (input.id && !existing)
    throw new ApplicationAccessError("Recurring issue not found in this team.")
  const conflict =
    "This recurring issue changed in another window. Reload before saving."
  if (
    existing &&
    (!input.updatedAt || existing.updatedAt.toISOString() !== input.updatedAt)
  )
    throw new Error(conflict)
  if (existing) {
    const rows = await db
      .update(teamRecurringIssues)
      .set({ payload: input.payload, updatedAt: new Date() })
      .where(
        and(
          eq(teamRecurringIssues.id, existing.id),
          eq(teamRecurringIssues.updatedAt, existing.updatedAt)
        )
      )
      .returning({ id: teamRecurringIssues.id })
    if (!rows[0]) throw new Error(conflict)
    return rows[0]
  }
  const [saved] = await db
    .insert(teamRecurringIssues)
    .values({
      workspaceId: actor.workspaceId,
      teamId: team.id,
      createdByUserId: actor.userId,
      payload: input.payload,
    })
    .returning({ id: teamRecurringIssues.id })
  return saved
}
export async function deleteRecurringIssue(
  actor: Actor,
  input: { slug: string; id: string; updatedAt: string }
) {
  actor = await requireCurrentActor(actor)
  const { team } = await scope(actor, input.slug, true)
  const rows = await db
    .delete(teamRecurringIssues)
    .where(
      and(
        eq(teamRecurringIssues.id, input.id),
        eq(teamRecurringIssues.workspaceId, actor.workspaceId),
        eq(teamRecurringIssues.teamId, team.id),
        eq(teamRecurringIssues.updatedAt, new Date(input.updatedAt))
      )
    )
    .returning({ id: teamRecurringIssues.id })
  if (!rows.length)
    throw new Error(
      "This recurring issue changed in another window. Reload before deleting."
    )
  return { ok: true }
}
