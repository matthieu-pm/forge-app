import "@tanstack/react-start/server-only"
import { and, desc, eq, isNull, sql } from "drizzle-orm"
import type { Transaction } from "@/db"
import type { Actor } from "@/application/actor"
import type { TemplateDirectory, TemplateDraft } from "@/lib/template-contract"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { requireCurrentActor } from "@/application/resource-policy.server"
import {
  ApplicationAccessError,
  canManageTeams,
  requireTeamRead,
} from "@/application/authorization"
import { db, members, teamTemplateDefaults, teamTemplates, users } from "@/db"
import { getTeamDirectory } from "@/application/teams/teams.server"

async function scope(actor: Actor, slug: string | undefined, write = false) {
  requireTeamRead(actor)
  if (write && !canManageTeams(actor))
    throw new ApplicationAccessError(
      "Only workspace owners and admins can manage templates."
    )
  const directory = await getTeamDirectory(actor, "active")
  if (!slug) return { team: null, directory }
  const team = directory.items.find((item) => item.slug === slug)
  if (!team)
    throw new ApplicationAccessError("You do not have access to this team.")
  return { team, directory }
}
export async function loadDirectory(
  actor: Actor,
  slug?: string
): Promise<TemplateDirectory> {
  actor = await requireCurrentActor(actor)
  const { team, directory } = await scope(actor, slug)
  const [records, defaults, people] = await Promise.all([
    db
      .select({ record: teamTemplates, creator: users.name })
      .from(teamTemplates)
      .innerJoin(users, eq(users.id, teamTemplates.createdByUserId))
      .where(
        and(
          eq(teamTemplates.workspaceId, actor.workspaceId),
          team
            ? eq(teamTemplates.teamId, team.id)
            : isNull(teamTemplates.teamId)
        )
      )
      .orderBy(desc(teamTemplates.createdAt)),
    team
      ? db
          .select()
          .from(teamTemplateDefaults)
          .where(eq(teamTemplateDefaults.teamId, team.id))
      : Promise.resolve([]),
    db.query.members.findMany({
      where: eq(members.organizationId, actor.workspaceId),
      with: { user: true },
    }),
  ])
  return {
    templates: records
      .filter(
        ({ record }) =>
          !record.payload.visibility ||
          directory.items.some((t) => t.id === record.payload.visibility)
      )
      .map(({ record, creator }) => ({
        id: record.id,
        payload: record.payload,
        createdBy: creator,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
      })),
    defaults: {
      members:
        defaults.find((d) => d.audience === "members")?.templateId ?? null,
      nonMembers:
        defaults.find((d) => d.audience === "nonMembers")?.templateId ?? null,
    },
    teams: directory.items,
    members: people.map((m) => ({
      id: m.userId,
      name: m.user.name,
      username: m.user.username,
      image: m.user.image,
    })),
    canManage: canManageTeams(actor),
  }
}
export async function saveTemplate(
  actor: Actor,
  input: {
    slug?: string
    id?: string
    updatedAt?: string
    payload: TemplateDraft
  }
) {
  return db.transaction(async (tx) => {
    actor = await currentCommandActor(tx, actor)
    await lockTemplateWrites(tx, actor)
    const { team, directory } = await scope(actor, input.slug, true)
    if (!team && !["issue", "project"].includes(input.payload.kind))
      throw new Error(
        "Only workspace issue and project templates are supported."
      )
    const allowedTeams = new Set(directory.items.map((t) => t.id))
    const people = await tx.query.members.findMany({
      where: eq(members.organizationId, actor.workspaceId),
    })
    const allowedPeople = new Set(people.map((p) => p.userId))
    const properties = [
      input.payload.properties,
      ...input.payload.issues.map((i) => i.properties),
      ...input.payload.subIssues.map((i) => i.properties),
    ]
    if (
      (team
        ? !allowedTeams.has(input.payload.visibility)
        : input.payload.visibility !== "" &&
          (input.payload.kind !== "project" ||
            !allowedTeams.has(input.payload.visibility))) ||
      properties.some(
        (p) =>
          (team && !p.teamIds.length) ||
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
      ? await tx.query.teamTemplates.findFirst({
          where: and(
            eq(teamTemplates.id, input.id),
            eq(teamTemplates.workspaceId, actor.workspaceId),
            team
              ? eq(teamTemplates.teamId, team.id)
              : isNull(teamTemplates.teamId)
          ),
        })
      : null
    if (input.id && !existing)
      throw new ApplicationAccessError("Template not found in this team.")
    if (existing && existing.payload.kind !== input.payload.kind)
      throw new Error("A template type cannot be changed after creation.")
    if (
      existing &&
      (!input.updatedAt || existing.updatedAt.toISOString() !== input.updatedAt)
    )
      throw new Error(
        "This template changed in another window. Reload before saving."
      )
    const duplicates = await tx
      .select()
      .from(teamTemplates)
      .where(
        and(
          eq(teamTemplates.workspaceId, actor.workspaceId),
          team
            ? eq(teamTemplates.teamId, team.id)
            : isNull(teamTemplates.teamId)
        )
      )
    if (
      duplicates.some(
        (t) =>
          t.id !== input.id &&
          t.payload.kind === input.payload.kind &&
          t.payload.name.toLocaleLowerCase() ===
            input.payload.name.toLocaleLowerCase()
      )
    )
      throw new Error("A template with this name already exists.")
    if (existing) {
      const savedRows = await tx
        .update(teamTemplates)
        .set({ payload: input.payload, updatedAt: new Date() })
        .where(
          and(
            eq(teamTemplates.id, existing.id),
            eq(teamTemplates.updatedAt, existing.updatedAt)
          )
        )
        .returning({ id: teamTemplates.id })
      const saved = savedRows.at(0)
      if (!saved)
        throw new Error(
          "This template changed in another window. Reload before saving."
        )
      return saved
    }
    const [saved] = await tx
      .insert(teamTemplates)
      .values({
        workspaceId: actor.workspaceId,
        teamId: team?.id ?? null,
        payload: input.payload,
        createdByUserId: actor.userId,
        updatedAt: new Date(),
      })
      .returning({ id: teamTemplates.id })
    return saved
  })
}
export async function deleteTemplate(
  actor: Actor,
  input: { slug?: string; id: string }
) {
  return db.transaction(async (tx) => {
    actor = await currentCommandActor(tx, actor)
    await lockTemplateWrites(tx, actor)
    const { team } = await scope(actor, input.slug, true)
    await tx
      .delete(teamTemplates)
      .where(
        and(
          eq(teamTemplates.id, input.id),
          eq(teamTemplates.workspaceId, actor.workspaceId),
          team
            ? eq(teamTemplates.teamId, team.id)
            : isNull(teamTemplates.teamId)
        )
      )
    return { ok: true }
  })
}
export async function setDefault(
  actor: Actor,
  input: {
    slug: string
    audience: "members" | "nonMembers"
    templateId: string | null
  }
) {
  return db.transaction(async (tx) => {
    actor = await currentCommandActor(tx, actor)
    await lockTemplateWrites(tx, actor)
    const { team } = await scope(actor, input.slug, true)
    if (!team) throw new ApplicationAccessError("Choose a team for defaults.")
    if (input.templateId) {
      const template = await tx.query.teamTemplates.findFirst({
        where: and(
          eq(teamTemplates.id, input.templateId),
          eq(teamTemplates.workspaceId, actor.workspaceId),
          eq(teamTemplates.teamId, team.id)
        ),
      })
      if (
        !template ||
        template.payload.kind !== "issue" ||
        (input.audience === "members" && template.payload.issueType === "form")
      )
        throw new Error("Choose an eligible issue template from this team.")
    }
    await tx
      .insert(teamTemplateDefaults)
      .values({
        teamId: team.id,
        audience: input.audience,
        templateId: input.templateId,
      })
      .onConflictDoUpdate({
        target: [teamTemplateDefaults.teamId, teamTemplateDefaults.audience],
        set: { templateId: input.templateId },
      })
    return { ok: true }
  })
}

async function lockTemplateWrites(tx: Transaction, actor: Actor) {
  await tx.execute(
    sql`SELECT id FROM organization WHERE id=${actor.workspaceId} FOR NO KEY UPDATE`
  )
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${actor.workspaceId},4040))`
  )
}
