import "@tanstack/react-start/server-only"
import { and, eq, inArray, or } from "drizzle-orm"
import { z } from "zod"
import { filterProjectCopy, projectCopyIds } from "./project-copies"
import {
  filterIssueCopy,
  hasRetainedCommandCopy,
  isIssueCopyKey,
  issueCopyIds,
  retainHiddenIssueCopies,
} from "./issue-copies"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type {
  ProductStateCommand,
  ProductStateSnapshot,
} from "@/lib/product-state-contract"
import { pruneTeamDocumentCopies } from "@/application/documents/document-copies.server"
import {
  isProjectCatalog,
  validateProjectCatalogChange,
} from "@/application/planning/project-catalog.server"
import {
  ensureTeamCycles,
  lockTeamCycles,
} from "@/application/cycles/cycles.server"
import { parseTeamCycles } from "@/lib/team-cycles-contract"
import { parseTeamTriage } from "@/lib/team-triage-contract"
import {
  db,
  issues,
  organizations,
  productState,
  projects,
  teamMembers,
  teams,
} from "@/db"
import {
  ApplicationAccessError,
  hasWorkspaceRole,
} from "@/application/authorization"
import {
  readableIssueCondition,
  readableProjectCondition,
  readableTeamCondition,
} from "@/application/resource-policy.server"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { executeCommand } from "@/application/commands/execute-command.server"
import { projectCommandPrefix } from "@/lib/shared-project-contract"
import {
  isProductStorageKey,
  productStateCommandSchema,
} from "@/lib/product-state-contract"

function session(
  actor: Actor,
  workspaceId = actor.workspaceId,
  sessionId?: string
) {
  if (
    actor.workspaceId !== workspaceId ||
    actor.authentication.kind !== "session" ||
    (sessionId && actor.authentication.sessionId !== sessionId)
  )
    throw new ApplicationAccessError()
}
async function scope(
  tx: Transaction,
  actor: Actor,
  key: string,
  write = false
) {
  if (!isProductStorageKey(key)) throw new ApplicationAccessError()
  const workspace =
    key.match(/^forge:workspace:([^:]+):/)?.[1] ??
    key.match(/^forge:project-statuses:v1:([^:]+)$/)?.[1]
  if (workspace && workspace !== actor.workspaceId)
    throw new ApplicationAccessError()
  const team =
    key.match(
      /^forge:(?:team-[^:]+|cycle-issues|triage-issues|triage-draft):v1:([0-9a-f-]{36})(?::[0-9a-f-]{36})?$/
    )?.[1] ?? key.match(/^forge:team-issue-labels:([0-9a-f-]{36}):v1$/)?.[1]
  if (team) {
    const row = (
      await tx
        .select()
        .from(teams)
        .where(and(eq(teams.id, team), readableTeamCondition(actor, teams.id)))
        .for("share")
    )[0]
    if (!row) throw new ApplicationAccessError()
    if (
      row.visibility === "private" &&
      !hasWorkspaceRole(actor, ["owner", "admin"])
    ) {
      if (
        !(
          await tx
            .select({ id: teamMembers.id })
            .from(teamMembers)
            .where(
              and(
                eq(teamMembers.workspaceId, actor.workspaceId),
                eq(teamMembers.teamId, team),
                eq(teamMembers.userId, actor.userId)
              )
            )
            .for("share")
        )[0]
      )
        throw new ApplicationAccessError()
    }
  }
  const postProject = key.match(
    /^forge:project-post-draft:v1:([0-9a-f-]{36})$/
  )?.[1]
  if (
    postProject &&
    !(
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.id, postProject),
            readableProjectCondition(actor, projects.id)
          )
        )
    )[0]
  )
    throw new ApplicationAccessError()
  const catalog = isProjectCatalog(key, actor.workspaceId)
  if (catalog && write && !hasWorkspaceRole(actor, ["owner", "admin"]))
    throw new ApplicationAccessError(
      "Only workspace admins can change project catalogs."
    )
  const shared =
    catalog ||
    /^forge:team-(?:cycles|triage|project-updates|thread-summaries):v1:/.test(
      key
    )
  if (write && shared && !hasWorkspaceRole(actor, ["owner", "admin"])) {
    // Project/initiative content is contributor work; configuration is administrative.
    if (!key.endsWith(":initiatives:v1"))
      throw new ApplicationAccessError(
        "Only workspace admins can change shared team settings."
      )
  }
  return shared ? "workspace" : `user:${actor.userId}`
}
async function visibleIssueCopyValue(
  tx: Transaction,
  current: Actor,
  key: string,
  value: string | null,
  previous?: string | null
) {
  if (value === null || !isIssueCopyKey(key)) return value
  const ids = issueCopyIds(key, value)
  if (previous) {
    try {
      ids.push(...issueCopyIds(key, previous))
    } catch {
      /* A valid replacement may recover an unsupported local copy. */
    }
  }
  const unique = [...new Set(ids)]
  const rows = unique.length
    ? await tx
        .select({
          id: issues.id,
          deletedAt: issues.deletedAt,
          archivedAt: issues.archivedAt,
          purgeStartedAt: issues.purgeStartedAt,
        })
        .from(issues)
        .where(
          and(
            inArray(issues.id, unique),
            readableIssueCondition(current, issues.id, true)
          )
        )
    : []
  const visible = new Set(
    rows.filter((row) => !row.deletedAt && !row.archivedAt).map((row) => row.id)
  )
  const projected = filterIssueCopy(
    key,
    value,
    (id) => visible.has(id),
    0,
    previous === undefined ? "read" : "scrub"
  )
  if (previous === undefined) return projected
  const retained = new Set(
    rows
      .filter(
        (row) =>
          !visible.has(row.id) &&
          !row.purgeStartedAt &&
          (!row.deletedAt ||
            row.deletedAt.getTime() + 720 * 3600000 > Date.now())
      )
      .map((row) => row.id)
  )
  const prior = previous ?? value
  if (hasRetainedCommandCopy(key, prior, retained)) {
    if (
      previous &&
      JSON.stringify(JSON.parse(previous)) !== JSON.stringify(JSON.parse(value))
    )
      throw new Error(
        "Restore or explicitly discard the saved batch containing an unavailable issue before replacing it."
      )
    return prior
  }
  return retainHiddenIssueCopies(key, projected, previous ?? value, retained)
}

export async function readProductState(
  actor: Actor
): Promise<ProductStateSnapshot> {
  session(actor)
  return db.transaction(async (tx) => {
    const current = await currentCommandActor(tx, actor)
    const rows = await tx
      .select()
      .from(productState)
      .where(
        and(
          eq(productState.workspaceId, current.workspaceId),
          or(
            eq(productState.ownerId, `user:${current.userId}`),
            eq(productState.ownerId, "workspace")
          )
        )
      )
    const readableProjects = await tx
      .select({ properties: projects.properties })
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, current.workspaceId),
          readableProjectCondition(current, projects.id)
        )
      )
    const entries: ProductStateSnapshot["entries"] = []
    for (const row of rows) {
      try {
        if ((await scope(tx, current, row.key)) === row.ownerId) {
          const original =
            row.encodedValue === null
              ? null
              : (JSON.parse(row.encodedValue) as string)
          const projectIds = projectCopyIds(row.key, original)
          const readable = projectIds.length
            ? await tx
                .select({ id: projects.id })
                .from(projects)
                .where(
                  and(
                    inArray(projects.id, projectIds),
                    readableProjectCondition(current, projects.id)
                  )
                )
            : []
          const projectValue = filterProjectCopy(row.key, original, (id) =>
            readable.some((project) => project.id === id)
          )
          const value = await visibleIssueCopyValue(
            tx,
            current,
            row.key,
            projectValue
          )
          let projectedValue = await pruneTeamDocumentCopies(
            tx,
            current,
            row.key,
            value
          )
          if (row.key === "forge:workspace-project-labels:v1" && value) {
            const directory = JSON.parse(value)
            const usage = (id: string) =>
              readableProjects.filter(
                (p) =>
                  Array.isArray(p.properties.labelIds) &&
                  p.properties.labelIds.includes(id)
              ).length
            projectedValue = JSON.stringify({
              ...directory,
              catalogRevision: row.revision,
              inheritedCount: 0,
              labels: directory.labels.map((label: { id: string }) => ({
                ...label,
                issues: usage(label.id),
                lastApplied: null,
              })),
              groups: directory.groups.map((group: { id: string }) => ({
                ...group,
                issues: usage(group.id),
                lastApplied: null,
              })),
            })
          }
          entries.push({
            key: row.key,
            value: projectedValue,
            revision: row.revision,
          })
        }
      } catch {
        /* Revoked/private resources are omitted. */
      }
    }
    for (const [key, value] of [
      [
        `forge:project-statuses:v1:${current.workspaceId}`,
        JSON.stringify(
          (await import("@/lib/project-statuses")).initialProjectStatuses()
        ),
      ],
      [
        "forge:workspace-project-labels:v1",
        JSON.stringify({
          version: 1,
          labels: [],
          groups: [],
          inheritedCount: 0,
          catalogRevision: 0,
        }),
      ],
    ])
      if (!entries.some((entry) => entry.key === key))
        entries.push({ key, value, revision: 0 })
    return {
      workspaceId: current.workspaceId,
      userId: current.userId,
      workspaceRole: current.workspaceRole,
      sessionId:
        actor.authentication.kind === "session"
          ? actor.authentication.sessionId
          : "",
      entries,
      teamIds: (
        await tx
          .select({ id: teams.id })
          .from(teams)
          .where(readableTeamCondition(current, teams.id))
      ).map((t) => t.id),
    }
  })
}
export async function saveProductState(actor: Actor, raw: ProductStateCommand) {
  const input = productStateCommandSchema.parse(raw)
  session(actor, input.workspaceId, input.sessionId)
  if (input.key.startsWith(projectCommandPrefix)) {
    if (input.value === null) throw new ApplicationAccessError()
    const { saveCanonicalProjects } =
      await import("@/application/planning/projects.server")
    return saveCanonicalProjects(
      actor,
      input.commandKey,
      JSON.parse(input.value)
    )
  }
  if (input.value !== null) {
    if (input.key.startsWith("forge:team-cycles:v1:"))
      parseTeamCycles(input.value)
    if (input.key.startsWith("forge:team-triage:v1:"))
      parseTeamTriage(input.value)
    if (input.key.startsWith("forge:team-project-updates:v1:"))
      z.object({ guidance: z.string().max(50000) }).parse(
        JSON.parse(input.value)
      )
    if (input.key.startsWith("forge:team-thread-summaries:v1:"))
      z.enum(["true", "false"]).parse(input.value)
  }
  const { commandKey, sessionId: _sessionId, ...commandInput } = input
  return executeCommand({
    actor,
    commandKey,
    operation: "productState.save@1",
    input: commandInput,
    status: 200,
    parse: (value) =>
      z.object({ revision: z.number().int() }).strict().parse(value),
    authorize: async (tx, current) => {
      session(current)
      await scope(tx, current, input.key, true)
    },
    run: async (tx, current) => {
      const ownerId = await scope(tx, current, input.key, true)
      if (isProjectCatalog(input.key, current.workspaceId)) {
        await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, current.workspaceId))
          .for("no key update")
        await validateProjectCatalogChange(tx, current, input.key, input.value)
      }
      const cycleTeamId = input.key.match(
        /^forge:team-cycles:v1:([0-9a-f-]{36})$/
      )?.[1]
      if (cycleTeamId) await lockTeamCycles(tx, cycleTeamId)
      if (isIssueCopyKey(input.key))
        await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, current.workspaceId))
          .for("no key update")
      await tx
        .insert(productState)
        .values({
          workspaceId: current.workspaceId,
          ownerId,
          ownerUserId: ownerId === "workspace" ? null : current.userId,
          teamId:
            input.key.match(
              /^forge:(?:team-[^:]+|cycle-issues|triage-issues|triage-draft):v1:([0-9a-f-]{36})(?::[0-9a-f-]{36})?$/
            )?.[1] ??
            input.key.match(
              /^forge:team-issue-labels:([0-9a-f-]{36}):v1$/
            )?.[1] ??
            null,
          key: input.key,
          encodedValue: null,
        })
        .onConflictDoNothing()
      const predicate = and(
        eq(productState.workspaceId, current.workspaceId),
        eq(productState.ownerId, ownerId),
        eq(productState.key, input.key)
      )
      const row = (
        await tx.select().from(productState).where(predicate).for("update")
      )[0]
      // Creation uniquely inserts this source in the issue transaction. A
      // discarded source is a tombstone, even if another tab refreshes its CAS revision.
      if (
        /^forge:file-draft:v1:[0-9a-f-]{36}:creation$/.test(input.key) &&
        input.value !== null &&
        row.encodedValue === null
      )
        throw new ApplicationAccessError(
          "The pending file source was discarded."
        )
      if (row.revision !== input.expectedRevision) {
        if (
          (row.encodedValue === null ? null : JSON.parse(row.encodedValue)) ===
          input.value
        )
          return {
            value: { revision: row.revision },
            resource: { type: "productState", id: row.id },
            events: [],
          }
        throw new Error(
          "This data changed in another session. Your pending changes are preserved in this session; reload the latest version before retrying."
        )
      }
      if (isProjectCatalog(input.key, current.workspaceId) && input.value) {
        const next = JSON.parse(input.value)
        if (
          input.key === "forge:workspace-project-labels:v1"
            ? next.catalogRevision !== row.revision
            : next.version !==
              (row.encodedValue
                ? JSON.parse(JSON.parse(row.encodedValue)).version
                : 0) +
                1
        )
          throw new Error(
            "This data changed in another session. Your catalog draft is preserved; load the latest version and review it."
          )
      }
      const projected = await visibleIssueCopyValue(
        tx,
        current,
        input.key,
        input.value,
        row.encodedValue === null
          ? null
          : (JSON.parse(row.encodedValue) as string)
      )
      const value = await pruneTeamDocumentCopies(
        tx,
        current,
        input.key,
        projected
      )
      await tx
        .update(productState)
        .set({
          encodedValue: value === null ? null : JSON.stringify(value),
          revision: row.revision + 1,
        })
        .where(predicate)
      if (cycleTeamId && input.value) {
        const settings = parseTeamCycles(input.value)
        const team = (
          await tx.select().from(teams).where(eq(teams.id, cycleTeamId))
        )[0]
        await ensureTeamCycles(
          tx,
          current.workspaceId,
          cycleTeamId,
          settings,
          settings.timezone ?? team.timezone
        )
      }
      return {
        value: { revision: row.revision + 1 },
        resource: { type: "productState", id: row.id },
        events: isProjectCatalog(input.key, current.workspaceId)
          ? [{ topic: "project.catalog.updated", payload: { key: input.key } }]
          : [],
      }
    },
  })
}
