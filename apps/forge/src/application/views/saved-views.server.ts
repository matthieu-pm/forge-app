import "@tanstack/react-start/server-only"
import { and, asc, eq, isNull, or, sql } from "drizzle-orm"
import { z } from "zod"
import type { InitiativeProject } from "@/lib/initiatives"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type {
  SavedViewDefinition,
  SavedViewDirectory,
} from "@/lib/saved-view-contract"
import {
  db,
  issues,
  members,
  organizations,
  projects,
  savedViewFavorites,
  savedViews,
  teams,
} from "@/db"
import {
  ApplicationAccessError,
  hasWorkspaceRole,
} from "@/application/authorization"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { executeCommand } from "@/application/commands/execute-command.server"
import {
  readableIssueCondition,
  readableProjectCondition,
  readableTeamCondition,
} from "@/application/resource-policy.server"
import {
  savedViewDefinitionSchema,
  savedViewMutationSchema,
} from "@/lib/saved-view-contract"

function enabled() {
  return process.env.FORGE_FEATURE_SAVED_VIEWS === "true"
}
function requireSession(actor: Actor) {
  if (actor.authentication.kind !== "session")
    throw new ApplicationAccessError()
}
function visibility(actor: Actor) {
  return and(
    eq(savedViews.workspaceId, actor.workspaceId),
    or(
      eq(savedViews.ownerId, actor.userId),
      eq(savedViews.visibility, "workspace"),
      and(
        eq(savedViews.visibility, "team"),
        readableTeamCondition(actor, savedViews.teamId)
      )
    ),
    // A team scope is a restriction even on a personal or workspace view.
    or(
      isNull(savedViews.teamId),
      readableTeamCondition(actor, savedViews.teamId)
    )
  )
}
function editable(actor: Actor, row: typeof savedViews.$inferSelect) {
  return (
    row.ownerId === actor.userId ||
    (row.visibility !== "personal" &&
      hasWorkspaceRole(actor, ["owner", "admin"]))
  )
}
const unavailable =
  "This view has unsupported filters or unavailable references. Review its filters before using it."

/** Recheck references on every read; never remove a filter and widen its result. */
async function validateReferences(
  tx: Transaction,
  actor: Actor,
  definition: SavedViewDefinition
) {
  const check = async (
    kind: "team" | "project" | "issue" | "member",
    id: string
  ) => {
    if (!id) return
    const rows =
      kind === "team"
        ? await tx
            .select({ id: teams.id })
            .from(teams)
            .where(
              and(eq(teams.id, id), readableTeamCondition(actor, teams.id))
            )
        : kind === "project"
          ? await tx
              .select({ id: projects.id })
              .from(projects)
              .where(
                and(
                  eq(projects.id, id),
                  readableProjectCondition(actor, projects.id)
                )
              )
          : kind === "issue"
            ? await tx
                .select({ id: issues.id })
                .from(issues)
                .where(
                  and(
                    eq(issues.id, id),
                    readableIssueCondition(actor, issues.id)
                  )
                )
            : await tx
                .select({ id: members.id })
                .from(members)
                .where(
                  and(
                    eq(members.organizationId, actor.workspaceId),
                    eq(members.userId, id)
                  )
                )
    if (!rows.length) throw new Error(unavailable)
  }
  if (definition.teamId) await check("team", definition.teamId)
  if (definition.kind === "issues") {
    for (const rule of definition.filters.rules) {
      if (["set", "notSet"].includes(rule.operator) || !rule.value) continue
      const kind =
        rule.field === "project"
          ? "project"
          : rule.field === "parentId"
            ? "issue"
            : ["assignee", "creator", "subscribers"].includes(rule.field)
              ? "member"
              : undefined
      if (kind) {
        if (kind !== "member" && !z.uuid().safeParse(rule.value).success)
          throw new Error(unavailable)
        await check(kind, rule.value)
      }
    }
  } else
    for (const rule of definition.filters) {
      if (!rule.value) continue
      const kind =
        rule.field === "Teams"
          ? "team"
          : rule.field === "Specific project"
            ? "project"
            : ["Lead", "Members"].includes(rule.field)
              ? "member"
              : undefined
      if (rule.field === "Initiatives")
        throw new Error(
          "Initiative filters are unavailable until shared initiatives are enabled."
        )
      if (kind) {
        if (kind !== "member" && !z.uuid().safeParse(rule.value).success)
          throw new Error(unavailable)
        await check(kind, rule.value)
      }
    }
}

export async function readSavedViews(
  actor: Actor
): Promise<SavedViewDirectory> {
  requireSession(actor)
  return db.transaction(
    async (tx) => {
      const current = await currentCommandActor(tx, actor)
      const result: SavedViewDirectory = {
        workspaceId: current.workspaceId,
        userId: current.userId,
        sessionId:
          current.authentication.kind === "session"
            ? current.authentication.sessionId
            : "",
        enabled: enabled(),
        views: [],
        error: "",
      }
      if (!result.enabled) return result
      const rows = await tx
        .select()
        .from(savedViews)
        .where(and(visibility(current), isNull(savedViews.deletedAt)))
        .orderBy(asc(savedViews.id))
        .limit(501)
      if (rows.length > 500)
        result.error = "The first 500 saved views are shown."
      const favorites = await tx
        .select({ id: savedViewFavorites.viewId })
        .from(savedViewFavorites)
        .where(
          and(
            eq(savedViewFavorites.workspaceId, current.workspaceId),
            eq(savedViewFavorites.userId, current.userId)
          )
        )
      for (const row of rows.slice(0, 500)) {
        const parsed = savedViewDefinitionSchema.safeParse(row.definition)
        if (
          !parsed.success ||
          parsed.data.visibility !== row.visibility ||
          (parsed.data.teamId ?? null) !== row.teamId
        ) {
          result.error = unavailable
          continue
        }
        try {
          await validateReferences(tx, current, parsed.data)
        } catch {
          result.error = unavailable
          continue
        }
        const { version: _version, ...definition } = parsed.data
        result.views.push({
          ...definition,
          id: row.id,
          ownerId: row.ownerId,
          favorite: favorites.some((f) => f.id === row.id),
          revision: row.revision,
          canEdit: editable(current, row),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })
      }
      return result
    },
    { isolationLevel: "repeatable read" }
  )
}
export async function mutateSavedView(
  actor: Actor,
  commandKey: string,
  raw: unknown
) {
  requireSession(actor)
  if (!enabled()) throw new Error("Saved views are not enabled.")
  const input = savedViewMutationSchema.parse(
    JSON.parse(JSON.stringify(savedViewMutationSchema.parse(raw)))
  )
  const resultSchema = z
    .object({ id: z.uuid(), revision: z.number().int().nonnegative() })
    .strict()
  let privatizedByAdmin = false
  return executeCommand({
    actor,
    commandKey,
    operation: "saved-views.mutate@1",
    input,
    status: 200,
    parse: (v) => resultSchema.parse(v),
    authorize: async (tx, current, value) => {
      requireSession(current)
      // An admin may intentionally remove their own read access by making
      // another creator's shared view personal. The acknowledgement is only
      // identity/revision; subsequent requests must authorize the new scope.
      if (value && privatizedByAdmin) return
      const row = (
        await tx
          .select()
          .from(savedViews)
          .where(and(eq(savedViews.id, input.id), visibility(current)))
      )[0]
      if (!row) {
        if (
          input.action === "save" &&
          input.expectedRevision === null &&
          !value
        )
          return
        throw new ApplicationAccessError()
      }
      if (input.action !== "favorite" && !editable(current, row))
        throw new ApplicationAccessError()
      // Receipts reveal only identity/revision; live visibility is always rechecked.
    },
    run: async (tx, current) => {
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, current.workspaceId))
        .for("no key update")
      const row = (
        await tx
          .select()
          .from(savedViews)
          .where(eq(savedViews.id, input.id))
          .for("update")
      )[0]
      if (row && (row.workspaceId !== current.workspaceId || row.deletedAt))
        throw new ApplicationAccessError()
      let revision = row?.revision ?? 0
      if (input.action === "favorite") {
        if (!row) throw new ApplicationAccessError()
        const key = and(
          eq(savedViewFavorites.workspaceId, current.workspaceId),
          eq(savedViewFavorites.userId, current.userId),
          eq(savedViewFavorites.viewId, input.id)
        )
        if (input.favorite)
          await tx
            .insert(savedViewFavorites)
            .values({
              workspaceId: current.workspaceId,
              userId: current.userId,
              viewId: input.id,
            })
            .onConflictDoNothing()
        else await tx.delete(savedViewFavorites).where(key)
      } else {
        if (
          input.expectedRevision === null
            ? Boolean(row)
            : !row || row.revision !== input.expectedRevision
        )
          throw new Error(
            "This view changed in another session. Your draft is kept. Reload the latest view and review your changes."
          )
        if (row && !editable(current, row)) throw new ApplicationAccessError()
        revision++
        if (input.action === "delete") {
          await tx
            .update(savedViews)
            .set({ deletedAt: new Date(), updatedAt: new Date(), revision })
            .where(eq(savedViews.id, input.id))
          await tx
            .delete(savedViewFavorites)
            .where(eq(savedViewFavorites.viewId, input.id))
        } else {
          await validateReferences(tx, current, input.definition)
          privatizedByAdmin = Boolean(
            row &&
            row.ownerId !== current.userId &&
            input.definition.visibility === "personal" &&
            hasWorkspaceRole(current, ["owner", "admin"])
          )
          const values = {
            definition: input.definition,
            visibility: input.definition.visibility,
            teamId: input.definition.teamId ?? null,
            revision,
            updatedAt: new Date(),
          }
          if (row)
            await tx
              .update(savedViews)
              .set(values)
              .where(eq(savedViews.id, input.id))
          else {
            const count = await tx
              .select({ n: sql<number>`count(*)::int` })
              .from(savedViews)
              .where(
                and(
                  eq(savedViews.workspaceId, current.workspaceId),
                  isNull(savedViews.deletedAt)
                )
              )
            if (count[0].n >= 500)
              throw new Error(
                "This workspace has reached its limit of 500 saved views."
              )
            await tx.insert(savedViews).values({
              ...values,
              id: input.id,
              workspaceId: current.workspaceId,
              ownerId: current.userId,
            })
          }
        }
      }
      return {
        value: { id: input.id, revision },
        resource: { type: "saved-view", id: input.id },
        events: [
          {
            topic: `saved-view.${input.action}`,
            payload: { viewId: input.id, version: 1 },
          },
        ],
      }
    },
  })
}

/** Bounded authorized project projection, filtered before returning to the browser. */
export async function queryViewProjects(actor: Actor, raw: unknown) {
  requireSession(actor)
  if (!enabled()) throw new Error("Saved views are not enabled.")
  const definition = savedViewDefinitionSchema.parse(raw)
  if (definition.kind !== "projects") throw new Error("Choose a project view.")
  const [{ visibleProjects }, { emptyInitiatives }] = await Promise.all([
    import("@/lib/projects"),
    import("@/lib/initiatives"),
  ])
  return db.transaction(
    async (tx) => {
      const current = await currentCommandActor(tx, actor)
      await validateReferences(tx, current, definition)
      const rows = await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.workspaceId, current.workspaceId),
            readableProjectCondition(current, projects.id)
          )
        )
        .orderBy(asc(projects.id))
        .limit(501)
      if (rows.length > 500)
        throw new Error(
          "This project view exceeds the supported limit of 500 projects."
        )
      const { projectTeams } = await import("@/db")
      const links = await tx
        .select()
        .from(projectTeams)
        .where(
          and(
            eq(projectTeams.workspaceId, current.workspaceId),
            readableTeamCondition(current, projectTeams.teamId)
          )
        )
      const visibleIds = new Set(rows.map((p) => p.id))
      const catalog = rows.map((p) => ({
        ...p.properties,
        dependencyIds: Array.isArray(p.properties.dependencyIds)
          ? p.properties.dependencyIds.filter(
              (id: unknown) => typeof id === "string" && visibleIds.has(id)
            )
          : [],
        id: p.id,
        name: p.name,
        revision: p.revision,
        teamIds: links.filter((l) => l.projectId === p.id).map((l) => l.teamId),
        status: p.properties.status ?? "Backlog",
        health: p.properties.health ?? "On track",
      })) as Array<InitiativeProject>
      return visibleProjects(
        catalog,
        emptyInitiatives(),
        definition.filters,
        definition.display,
        definition.teamId
      )
    },
    { isolationLevel: "repeatable read" }
  )
}
