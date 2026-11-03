import "@tanstack/react-start/server-only"
import { and, eq, isNull, or, sql } from "drizzle-orm"
import { z } from "zod"
import type {
  ImportEntry,
  ImportManifest,
} from "@/lib/import-execution-contract"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type { ImportModules } from "./content-manifest"
import type { SavedViewDefinition } from "@/lib/saved-view-contract"
import {
  documentRevisions,
  documents,
  initiativeProjects,
  initiatives,
  organizations,
  projects,
  savedViews,
  teamResourceBoards,
  teams,
} from "@/db"
import { commandInputHash } from "@/application/commands/command-input"
import { initiativeSettings } from "@/application/planning/initiative-gate.server"
import {
  canonicalInitiativeSaveCommand,
  lockProject,
} from "@/application/planning/initiatives.server"
import { canonicalProjectSaveCommand } from "@/application/planning/projects.server"
import { validateSavedViewReferences } from "@/application/views/saved-views.server"
import { requireIssueTeam } from "@/application/issues/issues.server"
import {
  readableDocumentCondition,
  readableProjectCondition,
  readableTeamCondition,
} from "@/application/resource-policy.server"
import { teamContentFeatureEnabled } from "@/application/team-content-feature-policy"
import { ApplicationAccessError } from "@/application/authorization"
import { initiativeFields } from "@/lib/shared-initiative-contract"
import {
  emptyTeamResources,
  teamResourceFieldsSchema,
} from "@/lib/team-resources-contract"
import { requireDocumentSection } from "@/application/documents/document-section.server"
import { documentBodySchema } from "@/lib/document-contract"
import { documentPlainText } from "@/lib/team-documents"
import { savedViewDefinitionSchema } from "@/lib/saved-view-contract"

export async function importModules(
  tx: Transaction,
  actor: Actor
): Promise<ImportModules> {
  return {
    initiatives: (await initiativeSettings(tx, actor)).enabled,
    documents: teamContentFeatureEnabled("FORGE_SHARED_DOCUMENTS_ENABLED"),
    resources: teamContentFeatureEnabled("FORGE_TEAM_RESOURCES_ENABLED"),
    views: process.env.FORGE_FEATURE_SAVED_VIEWS === "true",
    milestones: true,
  }
}
export async function requireContentModule(
  tx: Transaction,
  actor: Actor,
  entry: ImportEntry,
  enabledModules?: ImportModules
) {
  const modules = enabledModules ?? (await importModules(tx, actor))
  const enabled =
    entry.kind === "initiative"
      ? modules.initiatives
      : entry.kind === "document"
        ? modules.documents
        : entry.kind === "view"
          ? modules.views
          : entry.kind === "resource"
            ? modules.resources
            : entry.kind === "milestone"
  if (
    !enabled ||
    actor.authentication.kind !== "session" ||
    actor.scopes !== null
  )
    throw new ApplicationAccessError("This content module is unavailable.")
}
const hash = (value: unknown) =>
  commandInputHash(JSON.parse(JSON.stringify(value)))
export async function contentTarget(
  tx: Transaction,
  actor: Actor,
  entry: ImportEntry,
  id: string
) {
  await requireContentModule(tx, actor, entry)
  let row:
    { id: string; revision: number; title: string; value: unknown } | undefined
  if (entry.kind === "initiative") {
    const [r] = await tx
      .select()
      .from(initiatives)
      .where(
        and(
          eq(initiatives.id, id),
          eq(initiatives.workspaceId, actor.workspaceId)
        )
      )
      .for("share")
    if (r) {
      const links = await tx
        .select({ id: initiativeProjects.projectId })
        .from(initiativeProjects)
        .where(eq(initiativeProjects.initiativeId, id))
        .orderBy(initiativeProjects.projectId)
      // Never expose child names/identities through conflict snapshots.
      row = { id, revision: r.revision, title: r.name, value: { ...r, links } }
    }
  } else if (entry.kind === "document") {
    const [r] = await tx
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.id, id),
          eq(documents.workspaceId, actor.workspaceId),
          readableDocumentCondition(actor, documents.id),
          isNull(documents.deletedAt)
        )
      )
      .for("share")
    if (r) row = { id, revision: r.revision, title: r.title, value: r }
  } else if (entry.kind === "view") {
    const [r] = await tx
      .select()
      .from(savedViews)
      .where(
        and(
          eq(savedViews.id, id),
          eq(savedViews.workspaceId, actor.workspaceId),
          isNull(savedViews.deletedAt),
          sql`(${savedViews.ownerId}=${actor.userId} OR ${savedViews.visibility}='workspace' OR (${savedViews.visibility}='team' AND ${readableTeamCondition(actor, savedViews.teamId)}))`,
          sql`(${savedViews.teamId} IS NULL OR ${readableTeamCondition(actor, savedViews.teamId)})`
        )
      )
      .for("share")
    if (r)
      row = {
        id,
        revision: r.revision,
        title: String(r.definition.name),
        value: r,
      }
  } else if (entry.kind === "milestone") {
    const [r] = await tx
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, actor.workspaceId),
          readableProjectCondition(actor, projects.id),
          sql`${projects.properties}->'milestones' @> ${JSON.stringify([{ id }])}::jsonb`
        )
      )
      .for("share")
    const m = (
      r?.properties.milestones as
        Array<{ id: string; name: string }> | undefined
    )?.find((m) => m.id === id)
    if (r && m)
      row = {
        id,
        revision: r.revision,
        title: m.name,
        value: { projectId: r.id, m },
      }
  } else {
    await requireIssueTeam(tx, actor, entry.teamId)
    const [r] = await tx
      .select()
      .from(teamResourceBoards)
      .where(
        and(
          eq(teamResourceBoards.workspaceId, actor.workspaceId),
          eq(teamResourceBoards.teamId, entry.teamId)
        )
      )
      .for("share")
    const item =
      r && [...r.fields.sections, ...r.fields.links].find((x) => x.id === id)
    if (r && item)
      row = {
        id,
        revision: r.revision,
        title: "name" in item ? item.name : item.title,
        value: { teamId: entry.teamId, item },
      }
  }
  return row
    ? {
        id: row.id,
        title: row.title,
        revision: row.revision,
        fingerprint: hash(row.value),
        details: {},
      }
    : null
}
export async function contentCandidates(
  tx: Transaction,
  actor: Actor,
  entry: ImportEntry
) {
  if (entry.kind === "initiative")
    return tx
      .select({ id: initiatives.id })
      .from(initiatives)
      .where(
        and(
          eq(initiatives.workspaceId, actor.workspaceId),
          eq(initiatives.name, entry.title)
        )
      )
      .limit(21)
  if (entry.kind === "document") {
    const sourceId =
      entry.content?.kind === "document" ? entry.content.sourceId : ""
    return tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.workspaceId, actor.workspaceId),
          readableDocumentCondition(actor, documents.id),
          or(
            and(eq(documents.title, entry.title), isNull(documents.deletedAt)),
            z.uuid().safeParse(sourceId).success
              ? eq(documents.id, sourceId)
              : undefined
          )
        )
      )
      .limit(21)
  }
  if (entry.kind === "view")
    return tx
      .select({ id: savedViews.id })
      .from(savedViews)
      .where(
        and(
          eq(savedViews.workspaceId, actor.workspaceId),
          eq(savedViews.ownerId, actor.userId),
          isNull(savedViews.deletedAt),
          sql`${savedViews.definition}->>'name'=${entry.title}`
        )
      )
      .limit(21)
  // Scoped child identities are compared via aliases, not workspace-wide names.
  return []
}
export type ResolveContentReference = (
  kind: ImportEntry["kind"],
  legacyId: string
) => Promise<string>
export function contentDependencies(
  entry: ImportEntry
): Array<[ImportEntry["kind"], string]> {
  const c = entry.content
  if (!c) return []
  if (c.kind === "initiative") return c.projectIds.map((id) => ["project", id])
  if (c.kind === "milestone" || (c.kind === "document" && c.projectId))
    return [["project", c.projectId!]]
  if ((c.kind === "document" || c.kind === "resource") && c.sectionId)
    return [["resource", `section:${c.sectionId}`]]
  if (c.kind === "view") {
    const d = c.definition
    return (d.kind === "issues" ? d.filters.rules : d.filters).flatMap((r) => {
      const kind = ["project", "Specific project"].includes(r.field)
        ? "project"
        : r.field === "parentId"
          ? "issue"
          : null
      return kind &&
        r.value &&
        !("operator" in r && ["set", "notSet"].includes(r.operator))
        ? [[kind, r.value] as ["project" | "issue", string]]
        : []
    })
  }
  return []
}
async function mappedView(
  value: SavedViewDefinition,
  resolve: ResolveContentReference
) {
  const definition = structuredClone(value)
  for (const r of definition.kind === "issues"
    ? definition.filters.rules
    : definition.filters) {
    if (!r.value || ("operator" in r && ["set", "notSet"].includes(r.operator)))
      continue
    if (["project", "Specific project"].includes(r.field))
      r.value = await resolve("project", r.value)
    else if (r.field === "parentId") r.value = await resolve("issue", r.value)
  }
  return savedViewDefinitionSchema.parse(definition)
}
export async function createContent(
  tx: Transaction,
  actor: Actor,
  manifest: ImportManifest,
  entry: ImportEntry,
  resolve: ResolveContentReference,
  both: boolean
) {
  await requireContentModule(tx, actor, entry)
  const c = entry.content
  if (!c) throw new Error("The original content is unavailable.")
  // Existing document entry points use the source UUID. Preserve it so the
  // remaining legacy copy becomes recovery data instead of a second import.
  const id =
      c.kind === "document" && !both && z.uuid().safeParse(c.sourceId).success
        ? c.sourceId
        : crypto.randomUUID(),
    now = new Date()
  const events: Array<{ topic: string; payload: Record<string, unknown> }> = []
  let changedProjectId: string | undefined
  if (c.kind === "initiative") {
    const command = canonicalInitiativeSaveCommand(actor, manifest.id, [
      {
        id,
        expectedRevision: null,
        changes: initiativeFields.strip().parse(c.fields),
        addProjectIds: await Promise.all(
          c.projectIds.map((p) => resolve("project", p))
        ),
      },
    ])
    await command.authorize(tx, actor)
    const result = await command.run(tx, actor)
    events.push(...result.events)
  } else if (c.kind === "milestone") {
    const projectId = await resolve("project", c.projectId)
    await lockProject(tx, actor, projectId)
    const [p] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .for("update")
    const milestones = (p.properties.milestones ?? []) as Array<
      Record<string, unknown>
    >
    if (
      milestones.some((m) => m.id === c.fields.id || m.name === c.fields.name)
    )
      throw new Error(
        "A milestone with this identity or name already exists. Review the retained source."
      )
    const command = canonicalProjectSaveCommand(actor, manifest.id, [
      {
        id: projectId,
        expectedRevision: p.revision,
        changes: { milestones: [...milestones, { ...c.fields, id }] },
      },
    ])
    await command.authorize(tx, actor, undefined)
    const result = await command.run(tx, actor)
    events.push(...result.events)
    changedProjectId = projectId
  } else if (c.kind === "document") {
    const projectId = c.projectId ? await resolve("project", c.projectId) : null
    if (projectId) await lockProject(tx, actor, projectId)
    else await requireIssueTeam(tx, actor, entry.teamId)
    const sectionId = c.sectionId
      ? await resolve("resource", `section:${c.sectionId}`)
      : null
    const fields = { ...c.fields, sectionId }
    if (sectionId) {
      if (projectId)
        throw new Error(
          "Project documents cannot be placed in a team resource section."
        )
      if (!(await importModules(tx, actor)).resources)
        throw new Error("Resource sections are unavailable.")
      await requireDocumentSection(
        tx,
        actor.workspaceId,
        entry.teamId,
        sectionId
      )
    }
    await tx.insert(documents).values({
      id,
      workspaceId: actor.workspaceId,
      teamId: projectId ? null : entry.teamId,
      projectId,
      ownerId: actor.userId,
      updatedById: actor.userId,
      ...fields,
      body: fields.body as Record<string, unknown>,
      content: documentPlainText(fields.body),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    await tx.insert(documentRevisions).values({
      workspaceId: actor.workspaceId,
      documentId: id,
      revision: 1,
      snapshot: fields,
      authorId: actor.userId,
      createdAt: now,
    })
    events.push({
      topic: "document.create",
      payload: { documentId: id, revision: 1 },
    })
  } else if (c.kind === "view") {
    const definition = await mappedView(c.definition, resolve)
    savedViewDefinitionSchema.parse(definition)
    await validateSavedViewReferences(tx, actor, definition, true)
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(savedViews)
      .where(
        and(
          eq(savedViews.workspaceId, actor.workspaceId),
          isNull(savedViews.deletedAt)
        )
      )
    if (count.n >= 500)
      throw new Error(
        "This workspace has reached its limit of 500 saved views."
      )
    await tx.insert(savedViews).values({
      id,
      workspaceId: actor.workspaceId,
      ownerId: actor.userId,
      visibility: definition.visibility,
      teamId: definition.teamId ?? null,
      definition,
      revision: 1,
    })
    events.push({
      topic: "saved-view.save",
      payload: { viewId: id, revision: 1 },
    })
  } else {
    await requireIssueTeam(tx, actor, entry.teamId)
    const [board] = await tx
      .select()
      .from(teamResourceBoards)
      .where(eq(teamResourceBoards.teamId, entry.teamId))
      .for("update")
    const fields = structuredClone(board?.fields ?? emptyTeamResources())
    if ("name" in c.fields) fields.sections.push({ id, name: c.fields.name })
    else {
      fields.links.push({
        id,
        ...c.fields,
        sectionId: c.sectionId
          ? await resolve("resource", `section:${c.sectionId}`)
          : null,
      })
      fields.order.push(`link:${id}`)
    }
    const validated = teamResourceFieldsSchema.parse({
      sections: fields.sections,
      links: fields.links,
      order: fields.order,
    })
    const revision = (board?.revision ?? 0) + 1
    await tx
      .insert(teamResourceBoards)
      .values({
        teamId: entry.teamId,
        workspaceId: actor.workspaceId,
        revision,
        fields: validated,
      })
      .onConflictDoUpdate({
        target: teamResourceBoards.teamId,
        set: { fields: validated, revision, updatedAt: now },
      })
    events.push({
      topic: "team.resources.updated",
      payload: { teamId: entry.teamId, revision },
    })
  }
  return { id, events, changedProjectId }
}

/** Live source mappings are checked as well as the target's own revision. */
export async function contentRelationshipsMatch(
  tx: Transaction,
  actor: Actor,
  entry: ImportEntry,
  id: string,
  resolve: ResolveContentReference
) {
  const c = entry.content
  if (!c) return true
  if (c.kind === "initiative") {
    const actual = await tx
      .select({ id: initiativeProjects.projectId })
      .from(initiativeProjects)
      .where(eq(initiativeProjects.initiativeId, id))
    const expected = await Promise.all(
      c.projectIds.map((p) => resolve("project", p))
    )
    return (
      hash([...new Set(actual.map((p) => p.id))].sort()) ===
      hash([...new Set(expected)].sort())
    )
  }
  if (c.kind === "document") {
    const [row] = await tx
      .select()
      .from(documents)
      .where(
        and(eq(documents.id, id), eq(documents.workspaceId, actor.workspaceId))
      )
    return Boolean(
      row &&
      row.projectId ===
        (c.projectId ? await resolve("project", c.projectId) : null) &&
      row.teamId === (c.projectId ? null : entry.teamId) &&
      row.sectionId ===
        (c.sectionId
          ? await resolve("resource", `section:${c.sectionId}`)
          : null) &&
      !row.sharedWithWorkspace
    )
  }
  if (c.kind === "milestone") {
    const projectId = await resolve("project", c.projectId)
    const [row] = await tx
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          readableProjectCondition(actor, projects.id)
        )
      )
    return Boolean(
      (row?.properties.milestones as Array<{ id: string }> | undefined)?.some(
        (m) => m.id === id
      )
    )
  }
  if (c.kind === "resource" && "title" in c.fields) {
    const [row] = await tx
      .select()
      .from(teamResourceBoards)
      .where(eq(teamResourceBoards.teamId, entry.teamId))
    const link = row?.fields.links.find((l) => l.id === id)
    return Boolean(
      link &&
      link.sectionId ===
        (c.sectionId
          ? await resolve("resource", `section:${c.sectionId}`)
          : null)
    )
  }
  if (c.kind === "view") {
    const expected = await mappedView(c.definition, resolve)
    const [row] = await tx
      .select()
      .from(savedViews)
      .where(
        and(
          eq(savedViews.id, id),
          eq(savedViews.workspaceId, actor.workspaceId)
        )
      )
    return Boolean(
      row &&
      row.ownerId === actor.userId &&
      hash(row.definition) === hash(expected)
    )
  }
  return true
}

/** The displayed scope and actor are part of the immutable consent fingerprint. */
export async function contentImportConfirmation(
  tx: Transaction,
  actor: Actor,
  entry: ImportEntry,
  resolve: ResolveContentReference
) {
  const content = entry.content!
  const [workspace] = await tx
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, actor.workspaceId))
  let scope = "All workspace members"
  if (content.kind === "view") {
    scope =
      content.definition.visibility === "personal"
        ? "Only your account"
        : content.definition.visibility === "team"
          ? "team"
          : scope
  } else if (
    content.kind === "resource" ||
    (content.kind === "document" && !content.projectId)
  )
    scope = "team"
  if (scope === "team") {
    const [team] = await tx
      .select({ name: teams.name })
      .from(teams)
      .where(
        and(
          eq(teams.id, entry.teamId),
          eq(teams.workspaceId, actor.workspaceId)
        )
      )
    scope = `Team: ${team.name}`
  }
  if (
    content.kind === "milestone" ||
    (content.kind === "document" && content.projectId)
  ) {
    const id = await resolve("project", content.projectId!)
    const [project] = await tx
      .select({ name: projects.name })
      .from(projects)
      .where(
        and(eq(projects.id, id), readableProjectCondition(actor, projects.id))
      )
    scope = `Project: ${project.name} (project access)`
  }
  return {
    destination: `${workspace.name} · ${scope}`,
    actorId: actor.userId,
    workspaceId: actor.workspaceId,
    teamId: entry.teamId,
    policyVersion: 1,
    sourceChecksum: entry.sourceChecksum,
    entryId: entry.id,
  }
}

/** Bounded plain previews contain source content, never historical authorship claims. */
export function contentReviewSummary(entry: ImportEntry) {
  const content = entry.content
  if (!content) return undefined
  if (content.kind === "document")
    return documentPlainText(content.fields.body).slice(0, 4000)
  if (content.kind === "initiative" || content.kind === "milestone")
    return `${"summary" in content.fields ? content.fields.summary : content.fields.name}\n${content.fields.description ? documentPlainText(documentBodySchema.parse(content.fields.description)) : ""}`.slice(
      0,
      4000
    )
  if (content.kind === "view")
    return JSON.stringify(
      { kind: content.definition.kind, filters: content.definition.filters },
      null,
      2
    ).slice(0, 4000)
  return "url" in content.fields ? content.fields.url : content.fields.name
}
