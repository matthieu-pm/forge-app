import "@tanstack/react-start/server-only"
import { and, desc, eq } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import type { TemplateDirectory, TemplateDraft } from "@/lib/template-contract"
import {
  ApplicationAccessError,
  canManageTeams,
  requireTeamRead,
} from "@/application/authorization"
import { db, members, teamTemplateDefaults, teamTemplates, users } from "@/db"
import { getTeamDirectory } from "@/application/teams/teams.server"

async function scope(actor: Actor, slug: string, write = false) {
  requireTeamRead(actor)
  if (write && !canManageTeams(actor))
    throw new ApplicationAccessError(
      "Only workspace owners and admins can manage team templates."
    )
  const directory = await getTeamDirectory(actor, "active")
  const team = directory.items.find((item) => item.slug === slug)
  if (!team)
    throw new ApplicationAccessError("You do not have access to this team.")
  return { team, directory }
}
export async function loadDirectory(
  actor: Actor,
  slug: string
): Promise<TemplateDirectory> {
  const { team, directory } = await scope(actor, slug)
  const [records, defaults, people] = await Promise.all([
    db
      .select({ record: teamTemplates, creator: users.name })
      .from(teamTemplates)
      .innerJoin(users, eq(users.id, teamTemplates.createdByUserId))
      .where(
        and(
          eq(teamTemplates.workspaceId, actor.workspaceId),
          eq(teamTemplates.teamId, team.id)
        )
      )
      .orderBy(desc(teamTemplates.createdAt)),
    db
      .select()
      .from(teamTemplateDefaults)
      .where(eq(teamTemplateDefaults.teamId, team.id)),
    db.query.members.findMany({
      where: eq(members.organizationId, actor.workspaceId),
      with: { user: true },
    }),
  ])
  return {
    templates: records.map(({ record, creator }) => ({
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
      image: m.user.image,
    })),
    canManage: canManageTeams(actor),
  }
}
export async function saveTemplate(
  actor: Actor,
  input: {
    slug: string
    id?: string
    updatedAt?: string
    payload: TemplateDraft
  }
) {
  const { team, directory } = await scope(actor, input.slug, true)
  const allowedTeams = new Set(directory.items.map((t) => t.id))
  const people = await db.query.members.findMany({
    where: eq(members.organizationId, actor.workspaceId),
  })
  const allowedPeople = new Set(people.map((p) => p.userId))
  const properties = [
    input.payload.properties,
    ...input.payload.issues.map((i) => i.properties),
    ...input.payload.subIssues.map((i) => i.properties),
  ]
  if (
    !allowedTeams.has(input.payload.visibility) ||
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
    ? await db.query.teamTemplates.findFirst({
        where: and(
          eq(teamTemplates.id, input.id),
          eq(teamTemplates.workspaceId, actor.workspaceId),
          eq(teamTemplates.teamId, team.id)
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
  const duplicates = await db
    .select()
    .from(teamTemplates)
    .where(
      and(
        eq(teamTemplates.workspaceId, actor.workspaceId),
        eq(teamTemplates.teamId, team.id)
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
    const savedRows = await db
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
  const [saved] = await db
    .insert(teamTemplates)
    .values({
      workspaceId: actor.workspaceId,
      teamId: team.id,
      payload: input.payload,
      createdByUserId: actor.userId,
    })
    .returning({ id: teamTemplates.id })
  return saved
}
export async function deleteTemplate(
  actor: Actor,
  input: { slug: string; id: string }
) {
  const { team } = await scope(actor, input.slug, true)
  await db
    .delete(teamTemplates)
    .where(
      and(
        eq(teamTemplates.id, input.id),
        eq(teamTemplates.workspaceId, actor.workspaceId),
        eq(teamTemplates.teamId, team.id)
      )
    )
  return { ok: true }
}
export async function setDefault(
  actor: Actor,
  input: {
    slug: string
    audience: "members" | "nonMembers"
    templateId: string | null
  }
) {
  const { team } = await scope(actor, input.slug, true)
  if (input.templateId) {
    const template = await db.query.teamTemplates.findFirst({
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
  await db
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
}
