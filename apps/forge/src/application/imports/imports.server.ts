import "@tanstack/react-start/server-only"
import { and, desc, eq, isNull, or, sql } from "drizzle-orm"
import { z } from "zod"
import {
  contentCandidates,
  contentDependencies,
  contentRelationshipsMatch,
  contentTarget,
  createContent,
  importModules,
  requireContentModule,
} from "./content.server"
import { buildImportManifest, validatedImportFiles } from "./manifest"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type {
  ImportEntry,
  ImportManifest,
  ImportReconciliation,
  ImportSnapshot,
} from "@/lib/import-execution-contract"
import {
  db,
  issueCycles,
  issueLabels,
  issues,
  legacyImportAliases,
  legacyImports,
  organizations,
  productState,
  projectTeams,
  projects,
  resourceFiles,
  teamIssueNumbers,
  teams,
} from "@/db"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { executeCommand } from "@/application/commands/execute-command.server"
import { commandInputHash } from "@/application/commands/command-input"
import { ApplicationAccessError } from "@/application/authorization"
import {
  readableIssueCondition,
  readableProjectCondition,
  readableTeamCondition,
  requireResourceScope,
} from "@/application/resource-policy.server"
import {
  importedProjectSnapshot,
  requireIssueTeam,
  resolveIssueFields,
} from "@/application/issues/issues.server"
import { bindIssueFiles } from "@/application/issues/issue-files.server"
import { lockTeamCycles } from "@/application/cycles/cycles.server"
import { addCycleDays } from "@/lib/cycle-calendar"
import {
  initialTeamCycles,
  parseTeamCycles,
  teamCyclesStorageKey,
} from "@/lib/team-cycles-contract"
import { issueAttachmentAnchor } from "@/lib/issue-file-contract"
import { defaultDefinitionValue } from "@/lib/issue-definition-contract"
import {
  importChoiceSchema,
  importCutoverSchema,
  importFileRequestSchema,
  importRequestSchema,
} from "@/lib/import-execution-contract"

const owner = (actor: Actor) =>
  and(
    eq(legacyImports.workspaceId, actor.workspaceId),
    eq(legacyImports.userId, actor.userId)
  )
function session(actor: Actor) {
  if (actor.authentication.kind !== "session")
    throw new ApplicationAccessError()
}
async function authorize(
  tx: Transaction,
  actor: Actor,
  manifest: ImportManifest
) {
  session(actor)
  if (
    manifest.version !== 1 ||
    manifest.policyVersion !== 1 ||
    manifest.actorId !== actor.userId ||
    manifest.workspaceId !== actor.workspaceId
  )
    throw new ApplicationAccessError()
  const content = manifest.entries.filter(
    (entry) => entry.kind !== "issue" && entry.kind !== "project"
  )
  if (content.length) {
    const modules = await importModules(tx, actor)
    for (const entry of content)
      await requireContentModule(tx, actor, entry, modules)
  }
  for (const id of new Set(
    manifest.entries.flatMap(
      (e) =>
        e.teamIds ??
        e.project?.teamIds ??
        (z.uuid().safeParse(e.teamId).success ? [e.teamId] : [])
    )
  ))
    await requireIssueTeam(tx, actor, id)
}
const sourceBackupKey = (id: string, index: number) =>
  `forge:legacy-conflict:v1:import-${id}-${index}`
function encodeManifest(manifest: ImportManifest) {
  return JSON.stringify({
    ...manifest,
    sources: manifest.sources.map(({ key, checksum }) => ({ key, checksum })),
    entries: manifest.entries.map(
      ({
        draft: _draft,
        project: _project,
        content: _content,
        title: _title,
        ...entry
      }) => ({
        ...entry,
        conflict: entry.conflict
          ? {
              ...entry.conflict,
              candidates: entry.conflict.candidates.map(({ id, revision }) => ({
                id,
                revision,
              })),
            }
          : undefined,
        files: entry.files.map(({ data: _data, ...file }) => file),
      })
    ),
  })
}
async function hydrate(
  tx: Transaction,
  actor: Actor,
  manifest: ImportManifest
) {
  const sources = []
  for (const [index, source] of manifest.sources.entries()) {
    const [backup] = await tx
      .select()
      .from(productState)
      .where(
        and(
          eq(productState.workspaceId, actor.workspaceId),
          eq(productState.ownerId, `user:${actor.userId}`),
          eq(productState.key, sourceBackupKey(manifest.id, index))
        )
      )
    try {
      const preserved = JSON.parse(JSON.parse(backup?.encodedValue ?? "null"))
      if (
        preserved.key === source.key &&
        commandInputHash(preserved.value) === source.checksum
      )
        sources.push({ key: source.key, raw: preserved.value })
    } catch {
      /* Deleted or damaged private source cannot authorize a new effect. */
    }
  }
  const payload = buildImportManifest({
    id: manifest.id,
    actorId: actor.userId,
    workspaceId: actor.workspaceId,
    sources,
    defaultStatus: defaultDefinitionValue().statuses.defaultId,
    modules: manifest.contentVersion === 2 ? manifest.modules : undefined,
  })
  const payloadById = new Map(payload.entries.map((entry) => [entry.id, entry]))
  // Older executors omitted revision-bearing source records. Inventory them now;
  // a revision marker alone never proves that a core record reached the server.
  const recorded = new Set(manifest.entries.map((entry) => entry.id))
  for (const entry of payload.entries)
    if (entry.canonicalProjection && !recorded.has(entry.id))
      manifest.entries.push(entry)
  for (const entry of manifest.entries) {
    const original = payloadById.get(entry.id)
    entry.title = original?.title ?? "Unavailable source record"
    if (entry.conflict) {
      for (const candidate of entry.conflict.candidates) {
        const live = await target(tx, actor, entry, candidate.id)
        candidate.title = live?.title ?? "Unavailable shared record"
        candidate.details = live?.details
        candidate.canMigrateFiles = await conversionAvailable(
          tx,
          actor,
          entry,
          candidate.id
        )
      }
    }
    if (original) {
      entry.sourceChecksum = original.sourceChecksum
      entry.sourceValid = original.sourceValid
      entry.draft = original.draft
      entry.project = original.project
      entry.content = original.content
      entry.files = entry.files.map((file, index) => ({
        ...file,
        data: file.fileId ? "" : (original.files[index]?.data ?? ""),
      }))
    } else if (entry.state !== "saved" && entry.state !== "skipped") {
      entry.state = "quarantined"
      entry.message =
        "The original source is no longer available. No new effect can run."
    }
  }
  manifest.sourceErrors = [...(payload.sourceErrors ?? [])]
  if (sources.length !== manifest.sources.length)
    manifest.sourceErrors.push(
      "A private source backup is missing or its checksum differs."
    )
  const expected = new Set(payload.entries.map((entry) => entry.id))
  if (
    manifest.entries.length !== expected.size ||
    manifest.entries.some((entry) => !expected.has(entry.id))
  )
    manifest.sourceErrors.push(
      "Source and manifest record counts or identities differ."
    )
  manifest.sources = manifest.sources.map((source) => ({ ...source, raw: "" }))
}
async function load(tx: Transaction, actor: Actor, id: string, lock = true) {
  const query = tx
    .select()
    .from(legacyImports)
    .where(and(owner(actor), eq(legacyImports.id, id)))
  const [row] = await (lock ? query.for("update") : query)
  if (!row) throw new ApplicationAccessError()
  const manifest = JSON.parse(row.encodedManifest) as ImportManifest
  await authorize(tx, actor, manifest)
  await hydrate(tx, actor, manifest)
  await authorize(tx, actor, manifest)
  return manifest
}
async function save(tx: Transaction, manifest: ImportManifest) {
  manifest.revision++
  await tx
    .update(legacyImports)
    .set({
      revision: manifest.revision,
      encodedManifest: encodeManifest(manifest),
    })
    .where(eq(legacyImports.id, manifest.id))
}
function snapshot(
  manifest: ImportManifest,
  includeFileData = false
): ImportSnapshot {
  const pending = manifest.entries.filter((e) => e.state === "pending")
  const files = manifest.entries.filter(
    (e) => e.state === "saved" && e.files.some((f) => !f.fileId)
  )
  const visible = [
    ...new Map(
      [
        ...pending,
        ...files,
        ...manifest.entries.filter((e) => e.state === "review"),
        ...manifest.entries,
      ].map((e) => [e.id, e])
    ).values(),
  ].slice(0, 100)
  const fileEntry = files[0]?.id
  const { referenceContext: _references, ...clientManifest } = manifest
  return {
    ...clientManifest,
    totalCount: manifest.entries.length,
    savedCount: manifest.entries.filter((e) => e.state === "saved").length,
    pendingCount: pending.length,
    fileCount: files.reduce(
      (sum, e) => sum + e.files.filter((f) => !f.fileId).length,
      0
    ),
    sources: manifest.sources.map(({ key, checksum }) => ({ key, checksum })),
    entries: visible.map((entry) => ({
      ...entry,
      content: undefined,
      draft:
        entry.state === "review" && entry.draft
          ? {
              ...entry.draft,
              comments: [],
              activity: [],
              attachments: [],
              descriptionDoc: null,
              reactions: [],
            }
          : undefined,
      project:
        entry.state === "review" && entry.project
          ? {
              ...entry.project,
              description: null,
              comments: [],
              updates: [],
              resources: [],
              milestones: [],
            }
          : undefined,
      files: entry.files.map((file) => ({
        ...file,
        data:
          includeFileData && entry.id === fileEntry && !file.fileId
            ? file.data
            : "",
      })),
    })),
  }
}
/** Source bytes are read from authenticated private server backups, never trusted client manifests. */
export async function prepareImport(actor: Actor) {
  session(actor)
  return db.transaction(async (tx) => {
    const current = await currentCommandActor(tx, actor)
    await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, current.workspaceId))
      .for("no key update")
    const accessible = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(readableTeamCondition(current, teams.id))
    const keys = accessible.flatMap((t) =>
      ["team", "triage", "cycle"].map((k) => `forge:${k}-issues:v1:${t.id}`)
    )
    keys.push(
      `forge:workspace:${current.workspaceId}:initiatives:v1`,
      `forge:workspace:${current.workspaceId}:custom-views:v1:${current.userId}`,
      ...accessible.map((t) => `forge:team-home:v1:${t.id}`)
    )
    const modules = await importModules(tx, current)
    const rows = await tx
      .select()
      .from(productState)
      .where(
        and(
          eq(productState.workspaceId, current.workspaceId),
          eq(productState.ownerId, `user:${current.userId}`),
          sql`true`
        )
      )
    const sources: Array<{ key: string; raw: string }> = []
    const retainedSources: Array<{
      key: string
      raw: string
      backupKey: string
    }> = []
    const currentKeys = new Set(
      rows
        .filter((row) => keys.includes(row.key) && row.encodedValue)
        .map((row) => row.key)
    )
    for (const row of rows) {
      if (!row.encodedValue) continue
      if (keys.includes(row.key))
        sources.push({ key: row.key, raw: JSON.parse(row.encodedValue) })
      else if (row.key.startsWith("forge:legacy-conflict:v1:")) {
        try {
          const source = JSON.parse(JSON.parse(row.encodedValue))
          if (keys.includes(source.key) && typeof source.value === "string") {
            if (row.key.startsWith("forge:legacy-conflict:v1:import-"))
              retainedSources.push({
                key: source.key,
                raw: source.value,
                backupKey: row.key,
              })
            else sources.push({ key: source.key, raw: source.value })
          }
        } catch {
          /* The opaque backup remains available through product recovery. */
        }
      }
    }
    const completed = await tx
      .select({ encoded: legacyImports.encodedManifest })
      .from(legacyImports)
      .where(owner(current))
    const completedManifests = completed
      .map((row) => JSON.parse(row.encoded) as ImportManifest)
      .filter((m) => m.completedAt)
    const completedBackupKeys = new Set(
      completedManifests.flatMap((m) =>
        m.sources.map((_, index) => sourceBackupKey(m.id, index))
      )
    )
    for (const source of retainedSources)
      if (
        !currentKeys.has(source.key) &&
        completedBackupKeys.has(source.backupKey)
      )
        sources.push({ key: source.key, raw: source.raw })
    const settledSources = new Set(
      completedManifests
        .filter(
          (m) =>
            m.contentVersion === 2 &&
            commandInputHash(m.modules) === commandInputHash(modules)
        )
        .flatMap((m) =>
          [...m.sources, ...(m.cleanedSources ?? [])].map((s) =>
            JSON.stringify([s.key, s.checksum])
          )
        )
    )
    const referenceContext = completedManifests.flatMap((m) =>
      m.entries.flatMap((entry) =>
        entry.state === "saved" && entry.canonicalId
          ? [
              {
                id: entry.id,
                sourceKey: entry.sourceKey,
                sourceChecksum: entry.sourceChecksum,
                legacyId: entry.legacyId,
                legacyAliases: entry.legacyAliases,
                kind: entry.kind,
                teamId: entry.teamId,
                canonicalId: entry.canonicalId,
                manifestId: m.id,
                state: "saved" as const,
              },
            ]
          : []
      )
    )
    const unsettled = sources.filter(
      (s) =>
        !settledSources.has(JSON.stringify([s.key, commandInputHash(s.raw)]))
    )
    if (!unsettled.length) return null
    const manifest = buildImportManifest({
      id: crypto.randomUUID(),
      actorId: current.userId,
      workspaceId: current.workspaceId,
      sources: unsettled,
      modules,
      defaultStatus: defaultDefinitionValue().statuses.defaultId,
    })
    manifest.referenceContext = referenceContext
    if (!manifest.entries.length && !manifest.exclusions.length) return null
    await authorize(tx, current, manifest)
    const [existing] = await tx
      .select({ id: legacyImports.id })
      .from(legacyImports)
      .where(
        and(owner(current), eq(legacyImports.fingerprint, manifest.fingerprint))
      )
    if (existing) {
      const prior = await load(tx, current, existing.id)
      if (
        !prior.completedAt &&
        commandInputHash(prior.referenceContext ?? []) !==
          commandInputHash(referenceContext)
      ) {
        prior.referenceContext = referenceContext
        await save(tx, prior)
      }
      return snapshot(prior)
    }
    for (const [index, source] of manifest.sources.entries()) {
      await tx
        .insert(productState)
        .values({
          workspaceId: current.workspaceId,
          ownerId: `user:${current.userId}`,
          ownerUserId: current.userId,
          key: sourceBackupKey(manifest.id, index),
          encodedValue: JSON.stringify(
            JSON.stringify({
              key: source.key,
              value: source.raw,
              reason: "Import source snapshot",
              createdAt: manifest.createdAt,
            })
          ),
        })
        .onConflictDoNothing()
    }
    await tx
      .insert(legacyImports)
      .values({
        id: manifest.id,
        workspaceId: current.workspaceId,
        userId: current.userId,
        fingerprint: manifest.fingerprint,
        encodedManifest: encodeManifest(manifest),
      })
      .onConflictDoNothing()
    const [saved] = await tx
      .select()
      .from(legacyImports)
      .where(
        and(owner(current), eq(legacyImports.fingerprint, manifest.fingerprint))
      )
    return snapshot(await load(tx, current, saved.id))
  })
}
export async function readImports(actor: Actor) {
  session(actor)
  return db.transaction(async (tx) => {
    const current = await currentCommandActor(tx, actor)
    const rows = await tx
      .select({ id: legacyImports.id })
      .from(legacyImports)
      .where(owner(current))
      .orderBy(desc(legacyImports.createdAt))
      .limit(20)
    const values: Array<ImportSnapshot> = []
    for (const row of rows) {
      try {
        values.push(snapshot(await load(tx, current, row.id)))
      } catch (error) {
        if (!(error instanceof ApplicationAccessError)) throw error
      }
    }
    return values
  })
}
// Workspace-scoped content uses a reserved UUID because the v1 alias table requires a team UUID; it has no team FK.
const workspaceAliasScope = "00000000-0000-4000-8000-000000000000"
const aliasLegacyId = (actor: Actor, entry: ImportEntry) =>
  entry.kind === "view"
    ? JSON.stringify([actor.userId, entry.legacyId])
    : entry.legacyId
const aliasScope = (actor: Actor, entry: ImportEntry) =>
  and(
    eq(legacyImportAliases.workspaceId, actor.workspaceId),
    eq(legacyImportAliases.teamId, entry.teamId || workspaceAliasScope),
    eq(legacyImportAliases.kind, entry.kind),
    eq(legacyImportAliases.legacyId, aliasLegacyId(actor, entry))
  )
async function target(
  tx: Transaction,
  actor: Actor,
  entry: ImportEntry,
  id: string,
  lock = false
): Promise<{
  id: string
  title: string
  revision: number
  fingerprint: string
  details: Record<string, string>
  relationships?: {
    parentId: string | null
    projectId: string | null
    milestoneId: string | null
  }
} | null> {
  if (entry.kind !== "issue" && entry.kind !== "project")
    return contentTarget(tx, actor, entry, id)
  if (entry.kind === "issue") {
    const query = tx
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.id, id),
          readableIssueCondition(actor, issues.id),
          isNull(issues.deletedAt),
          isNull(issues.archivedAt)
        )
      )
    const [row] = await (lock ? query.for("share") : query)
    const parent = row?.parentId
      ? (
          await tx
            .select({ id: issues.id })
            .from(issues)
            .where(
              and(
                eq(issues.id, row.parentId),
                readableIssueCondition(actor, issues.id)
              )
            )
        )[0]
      : undefined
    const project = row?.projectId
      ? (
          await tx
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(
                eq(projects.id, row.projectId),
                readableProjectCondition(actor, projects.id)
              )
            )
        )[0]
      : undefined
    return row
      ? {
          id: row.id,
          title: row.title,
          details: {
            description: row.properties.description,
            status: row.statusId,
            assignee: row.assigneeId ?? "Unassigned",
            labels: row.properties.labels ?? "",
            project: project?.id ?? "",
            cycle: row.cycleId ?? "",
            parent: parent?.id ?? "",
          },
          relationships: {
            parentId: row.parentId,
            projectId: row.projectId,
            milestoneId: row.properties.milestone || null,
          },
          revision: row.revision,
          fingerprint: commandInputHash(JSON.parse(JSON.stringify(row))),
        }
      : null
  }
  const query = tx
    .select()
    .from(projects)
    .where(
      and(eq(projects.id, id), readableProjectCondition(actor, projects.id))
    )
  const [row] = await (lock ? query.for("share") : query)
  return row
    ? {
        id: row.id,
        title: row.name,
        details: {
          summary: String(row.properties.summary ?? ""),
          status: String(row.properties.status ?? ""),
          lead: String(row.properties.leadId ?? ""),
        },
        revision: row.revision,
        fingerprint: commandInputHash(JSON.parse(JSON.stringify(row))),
      }
    : null
}
async function conversionAvailable(
  tx: Transaction,
  actor: Actor,
  entry: ImportEntry,
  id: string
) {
  if (entry.kind !== "issue" || !entry.files.length) return false
  const [row] = await tx
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.id, id),
        eq(issues.legacyId, entry.legacyId),
        readableIssueCondition(actor, issues.id),
        isNull(issues.deletedAt),
        isNull(issues.archivedAt)
      )
    )
  if (!row) return false
  try {
    const legacy = validatedImportFiles(
      (row.properties.attachments ?? []).filter((f) => !f.fileId)
    )
    const keys = (files: typeof legacy) =>
      files.map((f) => JSON.stringify([f.name, f.checksum, f.sizeBytes])).sort()
    return JSON.stringify(keys(legacy)) === JSON.stringify(keys(entry.files))
  } catch {
    return false
  }
}
async function recordAlias(
  tx: Transaction,
  actor: Actor,
  entry: ImportEntry,
  id: string
) {
  const row = await target(tx, actor, entry, id)
  if (!row) throw new ApplicationAccessError()
  await tx
    .insert(legacyImportAliases)
    .values({
      workspaceId: actor.workspaceId,
      teamId: entry.teamId || workspaceAliasScope,
      kind: entry.kind,
      legacyId: aliasLegacyId(actor, entry),
      fingerprint: entry.fingerprint,
      canonicalId: id,
      targetFingerprint: row.fingerprint,
    })
    .onConflictDoUpdate({
      target: [
        legacyImportAliases.workspaceId,
        legacyImportAliases.teamId,
        legacyImportAliases.kind,
        legacyImportAliases.legacyId,
        legacyImportAliases.fingerprint,
      ],
      set: { canonicalId: id, targetFingerprint: row.fingerprint },
    })
}
async function reconcile(
  tx: Transaction,
  actor: Actor,
  manifest: ImportManifest,
  entry: ImportEntry
) {
  const mapping =
    entry.kind === "issue" && entry.draft && !entry.canonicalProjection
      ? {
          milestoneId:
            manifest.modules?.milestones && entry.draft.milestone
              ? await reference(
                  tx,
                  actor,
                  manifest,
                  entry,
                  "milestone",
                  `${entry.draft.project}::${entry.draft.milestone}`
                )
              : undefined,
          parentId:
            (await reference(
              tx,
              actor,
              manifest,
              entry,
              "issue",
              entry.draft.parentId
            )) || null,
          projectId:
            (await reference(
              tx,
              actor,
              manifest,
              entry,
              "project",
              entry.draft.project ?? ""
            )) || null,
        }
      : undefined
  const aliases = await tx
    .select()
    .from(legacyImportAliases)
    .where(aliasScope(actor, entry))
  const exact = aliases.find((a) => a.fingerprint === entry.fingerprint)
  if (exact && !entry.reviewRequired) {
    const row = await target(tx, actor, entry, exact.canonicalId, true)
    if (
      row?.fingerprint === exact.targetFingerprint &&
      (await contentRelationshipsMatch(
        tx,
        actor,
        entry,
        exact.canonicalId,
        (kind, id) => reference(tx, actor, manifest, entry, kind, id)
      )) &&
      (!mapping ||
        (row.relationships?.parentId === mapping.parentId &&
          row.relationships.projectId === mapping.projectId &&
          (mapping.milestoneId === undefined ||
            row.relationships.milestoneId === mapping.milestoneId)))
    ) {
      if (entry.files.length) {
        const [issue] = await tx
          .select()
          .from(issues)
          .where(eq(issues.id, row.id))
        if (
          !entry.files.every((source) =>
            issue?.properties.attachments?.some(
              (f) =>
                f.fileId &&
                !f.data &&
                f.name === source.name &&
                f.checksum === source.checksum &&
                f.sizeBytes === source.sizeBytes
            )
          )
        ) {
          entry.state = "review"
          entry.message =
            "An overlapping import has unfinished files. Resume that import, or review keeping a separate copy."
        } else return { reuse: row.id }
      } else return { reuse: row.id }
    }
  }
  const possible = entry.canonicalProjection
    ? []
    : entry.kind !== "issue" && entry.kind !== "project"
      ? await contentCandidates(tx, actor, entry)
      : entry.kind === "issue"
        ? await tx
            .select({ id: issues.id })
            .from(issues)
            .where(
              and(
                eq(issues.workspaceId, actor.workspaceId),
                eq(issues.teamId, entry.teamId),
                or(
                  eq(issues.legacyId, entry.legacyId),
                  sql`lower(btrim(${issues.title}))=${entry.title.trim().toLowerCase()}`,
                  entry.draft?.description
                    ? eq(
                        sql`${issues.properties}->>'description'`,
                        entry.draft.description
                      )
                    : undefined
                ),
                readableIssueCondition(actor, issues.id),
                isNull(issues.deletedAt)
              )
            )
            .limit(21)
        : await tx
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(
                eq(projects.workspaceId, actor.workspaceId),
                or(
                  eq(projects.legacyId, entry.legacyId),
                  sql`lower(btrim(${projects.name}))=${entry.title.trim().toLowerCase()}`
                ),
                readableProjectCondition(actor, projects.id)
              )
            )
            .limit(21)
  const candidates = []
  for (const id of new Set([
    ...(entry.canonicalProjection ? [] : aliases.map((a) => a.canonicalId)),
    ...possible.map((p) => p.id),
    ...(entry.canonicalProjection && entry.canonicalId
      ? [entry.canonicalId]
      : []),
  ])) {
    const row = await target(tx, actor, entry, id, true)
    if (row) candidates.push(row)
  }
  if (!aliases.length && !possible.length && !entry.canonicalProjection) {
    delete entry.conflict
    return {}
  }
  const fingerprint = commandInputHash(
    JSON.parse(
      JSON.stringify({
        source: entry.fingerprint,
        mapping: mapping ? JSON.parse(JSON.stringify(mapping)) : undefined,
        contentMapping: await Promise.all(
          contentDependencies(entry).map(async ([kind, id]) => [
            kind,
            id,
            await reference(tx, actor, manifest, entry, kind, id),
          ])
        ),
        aliases,
        candidates,
      })
    )
  )
  entry.conflict = {
    fingerprint,
    candidates: await Promise.all(
      candidates.map(async ({ id, title, revision, details }) => ({
        id,
        title,
        revision,
        details,
        canMigrateFiles: await conversionAvailable(tx, actor, entry, id),
      }))
    ),
  }
  if (entry.decision?.fingerprint !== fingerprint) {
    entry.state = "review"
    entry.message =
      "A matching or changed shared record needs your review. No shared content was changed."
    return { blocked: true }
  }
  if (
    entry.canonicalProjection &&
    entry.decision.choice !== "keep-server" &&
    entry.decision.choice !== "skip"
  ) {
    entry.state = "review"
    entry.message =
      "Keep or skip the existing canonical record. A saved projection cannot authorize a new copy."
    return { blocked: true }
  }
  if (entry.decision.choice === "migrate-files") {
    if (
      candidates.length === 1 &&
      (await conversionAvailable(tx, actor, entry, candidates[0].id))
    )
      return { convert: candidates[0].id }
    entry.state = "review"
    entry.message =
      "The existing legacy files changed. Review the current record again."
    return { blocked: true }
  }
  if (entry.decision.choice === "skip") return { skip: true }
  if (entry.decision.choice === "keep-server") {
    // A single unambiguous, live target is required for remapping dependents.
    if (candidates.length !== 1) {
      entry.state = "review"
      entry.message =
        "Skip this record or keep both; there is no single available target."
      return { blocked: true }
    }
    return { reuse: candidates[0].id, reviewed: true }
  }
  return { both: true }
}
function referenceEntries(
  manifest: ImportManifest,
  entry: ImportEntry,
  kind: ImportEntry["kind"],
  legacyId: string
) {
  if (!legacyId) return []
  const matches = (
    e: Pick<ImportEntry, "kind" | "teamId" | "legacyId" | "legacyAliases">
  ) =>
    e.kind === kind &&
    (["project", "initiative", "view"].includes(kind) ||
      e.teamId === entry.teamId) &&
    (e.legacyId === legacyId || Boolean(e.legacyAliases?.includes(legacyId)))
  const local = manifest.entries.filter(matches)
  const candidates = local.length
    ? local
    : (manifest.referenceContext ?? []).filter(matches)
  const sameSnapshot = candidates.filter(
    (e) =>
      e.sourceKey === entry.sourceKey &&
      e.sourceChecksum === entry.sourceChecksum
  )
  const sameSource = candidates.filter((e) => e.sourceKey === entry.sourceKey)
  return sameSnapshot.length
    ? sameSnapshot
    : sameSource.length
      ? sameSource
      : candidates
}
async function reference(
  tx: Transaction,
  actor: Actor,
  manifest: ImportManifest,
  entry: ImportEntry,
  kind: ImportEntry["kind"],
  legacyId: string
) {
  if (!legacyId) return ""
  const selected = referenceEntries(manifest, entry, kind, legacyId)
  const ids = [
    ...new Set(
      selected
        .map((e) => e.canonicalId)
        .filter((id): id is string => Boolean(id))
    ),
  ]
  if (
    selected.length &&
    (ids.length !== 1 || selected.some((e) => !e.canonicalId))
  )
    throw new Error("A referenced source record must be resolved first.")
  for (const selectedEntry of selected) {
    if (!("manifestId" in selectedEntry)) continue
    const [origin] = await tx
      .select()
      .from(legacyImports)
      .where(and(owner(actor), eq(legacyImports.id, selectedEntry.manifestId)))
      .for("share")
    const settled = origin
      ? (JSON.parse(origin.encodedManifest) as ImportManifest)
      : null
    const original = settled?.entries.find((e) => e.id === selectedEntry.id)
    if (
      !settled?.completedAt ||
      settled.actorId !== actor.userId ||
      settled.workspaceId !== actor.workspaceId ||
      original?.state !== "saved" ||
      original.canonicalId !== selectedEntry.canonicalId ||
      original.kind !== selectedEntry.kind ||
      original.teamId !== selectedEntry.teamId ||
      original.legacyId !== selectedEntry.legacyId ||
      original.sourceKey !== selectedEntry.sourceKey ||
      original.sourceChecksum !== selectedEntry.sourceChecksum ||
      !(await target(tx, actor, original, original.canonicalId!))
    )
      throw new Error(
        "A settled reference changed or is unavailable. Refresh import progress before retrying."
      )
    const index = settled.sources.findIndex(
      (source) =>
        source.key === original.sourceKey &&
        source.checksum === original.sourceChecksum
    )
    const [backup] = await tx
      .select()
      .from(productState)
      .where(
        and(
          eq(productState.workspaceId, actor.workspaceId),
          eq(productState.ownerId, `user:${actor.userId}`),
          eq(productState.key, sourceBackupKey(settled.id, index))
        )
      )
      .for("share")
    try {
      const preserved = JSON.parse(JSON.parse(backup?.encodedValue ?? "null"))
      if (
        preserved.key !== original.sourceKey ||
        commandInputHash(preserved.value) !== original.sourceChecksum
      )
        throw new Error("checksum")
    } catch {
      throw new Error(
        "A settled reference backup is unavailable. Its mapping cannot be reconciled."
      )
    }
  }
  if (ids.length === 1) return ids[0]
  if (kind !== "issue" && kind !== "project") {
    const live = z.uuid().safeParse(legacyId).success
      ? await target(tx, actor, { ...entry, kind }, legacyId)
      : null
    if (!live)
      throw new Error("A content relationship is missing or unavailable.")
    return live.id
  }
  const table = kind === "issue" ? issues : projects
  const possible = await tx
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        eq(table.workspaceId, actor.workspaceId),
        or(
          eq(table.legacyId, legacyId),
          z.uuid().safeParse(legacyId).success
            ? eq(table.id, legacyId)
            : undefined
        ),
        kind === "issue"
          ? and(
              eq(issues.teamId, entry.teamId),
              readableIssueCondition(actor, issues.id),
              isNull(issues.deletedAt),
              isNull(issues.archivedAt)
            )
          : readableProjectCondition(actor, projects.id)
      )
    )
  if (possible.length !== 1)
    throw new Error(
      "A reference is missing, ambiguous or unavailable. Its source remains preserved."
    )
  return possible[0].id
}
async function createEntry(
  tx: Transaction,
  actor: Actor,
  manifest: ImportManifest,
  entry: ImportEntry,
  both: boolean
) {
  let id: string
  if (entry.content) {
    if (entry.content.kind === "milestone") {
      const projectId = await reference(
        tx,
        actor,
        manifest,
        entry,
        "project",
        entry.content.projectId
      )
      for (const parent of manifest.entries.filter(
        (e) =>
          e.kind === "project" &&
          e.state === "saved" &&
          e.canonicalId === projectId
      )) {
        if (
          (await target(tx, actor, parent, projectId))?.fingerprint !==
          parent.targetFingerprint
        )
          throw new Error(
            "The linked project changed. Retry unresolved records and review it before extending its milestones."
          )
      }
    }
    const result = await createContent(
      tx,
      actor,
      manifest,
      entry,
      (kind, legacyId) => reference(tx, actor, manifest, entry, kind, legacyId),
      both
    )
    await recordAlias(tx, actor, entry, result.id)
    return result
  }
  if (entry.kind === "project") {
    requireResourceScope(actor, "projects:write")
    const project = entry.project!
    for (const teamId of project.teamIds)
      await requireIssueTeam(tx, actor, teamId)
    const properties = await importedProjectSnapshot(tx, actor, project)
    // Advanced planning relationships are retained privately until their adapter is enabled.
    const [row] = await tx
      .insert(projects)
      .values({
        workspaceId: actor.workspaceId,
        name: project.name,
        legacyId: both ? null : entry.legacyId,
        properties: {
          name: project.name,
          status: project.status,
          health: project.health,
          summary: project.summary ?? "",
          description: project.description ?? null,
          icon: project.icon,
          priority: project.priority,
          leadId: project.leadId ?? "",
          memberIds: project.memberIds ?? [],
          teamIds: project.teamIds,
          startDate: project.startDate ?? "",
          targetDate: project.targetDate ?? "",
          creatorId: properties.creatorId,
          createdAt: properties.createdAt,
          updatedAt: properties.updatedAt,
          legacyFingerprint: properties.legacyFingerprint,
          dependencyIds: [],
          milestones: [],
          resources: [],
          comments: [],
          updates: [],
          labelIds: [],
        },
      })
      .returning()
    await tx.insert(projectTeams).values(
      [...new Set(project.teamIds)].map((teamId) => ({
        workspaceId: actor.workspaceId,
        projectId: row.id,
        teamId,
      }))
    )
    id = row.id
  } else {
    const draft = {
      ...entry.draft!,
      attachments: [],
      comments: [],
      activity: [],
      reactions: [],
      subscribers: "",
      recurrence: "" as const,
      agent: "",
      agentSession: "",
      favorite: false,
      milestone: "",
      subIssues: [],
    }
    draft.parentId = await reference(
      tx,
      actor,
      manifest,
      entry,
      "issue",
      draft.parentId
    )
    draft.project = await reference(
      tx,
      actor,
      manifest,
      entry,
      "project",
      draft.project ?? ""
    )
    if (manifest.modules?.milestones && entry.draft?.milestone) {
      draft.milestone = await reference(
        tx,
        actor,
        manifest,
        entry,
        "milestone",
        `${entry.draft.project}::${entry.draft.milestone}`
      )
    }
    if (
      draft.cycle &&
      !z.uuid().safeParse(draft.cycle).success &&
      !z.iso.date().safeParse(draft.cycle).success
    )
      throw new Error(
        "This cycle needs an explicit valid date or canonical ID mapping."
      )
    if (z.iso.date().safeParse(draft.cycle).success) {
      await lockTeamCycles(tx, entry.teamId)
      const [existing] = await tx
        .select()
        .from(issueCycles)
        .where(
          and(
            eq(issueCycles.teamId, entry.teamId),
            eq(issueCycles.startDate, draft.cycle)
          )
        )
      if (!existing) {
        const team = await requireIssueTeam(tx, actor, entry.teamId)
        const [saved] = await tx
          .select()
          .from(productState)
          .where(
            and(
              eq(productState.workspaceId, actor.workspaceId),
              eq(productState.ownerId, "workspace"),
              eq(productState.key, teamCyclesStorageKey(entry.teamId))
            )
          )
        const settings = saved?.encodedValue
          ? parseTeamCycles(JSON.parse(saved.encodedValue))
          : initialTeamCycles()
        const [cycle] = await tx
          .insert(issueCycles)
          .values({
            workspaceId: actor.workspaceId,
            teamId: entry.teamId,
            startDate: draft.cycle,
            endDate: addCycleDays(draft.cycle, settings.duration * 7 - 1),
            timezone: settings.timezone ?? team.timezone,
          })
          .returning()
        draft.cycle = cycle.id
      } else draft.cycle = existing.id
    }
    const resolved = await resolveIssueFields(tx, actor, {
      teamId: entry.teamId,
      commandKey: manifest.id,
      draft,
      assigneeId: draft.assignee || null,
    })
    await tx
      .insert(teamIssueNumbers)
      .values({ teamId: entry.teamId })
      .onConflictDoNothing()
    const [number] = await tx
      .update(teamIssueNumbers)
      .set({ lastNumber: sql`${teamIssueNumbers.lastNumber}+1` })
      .where(eq(teamIssueNumbers.teamId, entry.teamId))
      .returning()
    const properties = {
      ...draft,
      legacyFingerprint: entry.fingerprint,
      completedAt:
        resolved.status.group === "completed" ? new Date().toISOString() : null,
      statusChangedAt: new Date().toISOString(),
    }
    const [row] = await tx
      .insert(issues)
      .values({
        workspaceId: actor.workspaceId,
        teamId: entry.teamId,
        number: number.lastNumber,
        title: draft.title,
        statusId: resolved.status.id,
        projectId: resolved.projectId,
        parentId: resolved.parentId,
        cycleId: resolved.cycleId,
        assigneeId: resolved.assignee,
        creatorId: actor.userId,
        legacyId: both ? null : entry.legacyId,
        properties,
      })
      .returning()
    if (resolved.labels.length)
      await tx.insert(issueLabels).values(
        resolved.labels.map((l) => ({
          workspaceId: actor.workspaceId,
          issueId: row.id,
          labelId: l.id,
        }))
      )
    id = row.id
  }
  await recordAlias(tx, actor, entry, id)
  return {
    id,
    events: [] as Array<{ topic: string; payload: Record<string, unknown> }>,
    changedProjectId: undefined as string | undefined,
  }
}
export async function runImportBatch(
  actor: Actor,
  raw: z.infer<typeof importRequestSchema>
) {
  const input = importRequestSchema.parse(raw)
  await executeCommand({
    actor,
    commandKey: `import:${input.id}:${input.revision}`,
    operation: "imports.batch@1",
    input: { id: input.id, revision: input.revision },
    status: 200,
    parse: (v) => z.object({ id: z.uuid() }).parse(v),
    authorize: async (tx, current) => {
      await load(tx, current, input.id, false)
    },
    run: async (tx, current) => {
      // Same workspace fence as canonical creation and graph mutations; effects and checkpoints commit together.
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, current.workspaceId))
        .for("no key update")
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${current.workspaceId},4040))`
      )
      await tx.execute(
        sql`SELECT public.forge_lock_issue_graph(${current.workspaceId})`
      )
      const manifest = await load(tx, current, input.id)
      if (manifest.completedAt) throw new Error("This import is completed.")
      if (manifest.revision !== input.revision)
        return {
          value: { id: manifest.id },
          resource: { type: "legacyImport", id: manifest.id },
          events: [],
        }
      const events: Array<{ topic: string; payload: Record<string, unknown> }> =
        []
      const pending = manifest.entries.filter((e) => e.state === "pending")
      // Projects, then roots, then children. Unresolved/circular graphs remain recoverable.
      pending.sort(
        (a, b) =>
          [
            "project",
            "resource",
            "milestone",
            "initiative",
            "document",
            "issue",
            "view",
          ].indexOf(a.kind) -
            [
              "project",
              "resource",
              "milestone",
              "initiative",
              "document",
              "issue",
              "view",
            ].indexOf(b.kind) ||
          Number(Boolean(a.draft?.parentId)) -
            Number(Boolean(b.draft?.parentId))
      )
      let processed = 0
      while (pending.length && processed++ < 10) {
        const index = pending.findIndex(
          (e) =>
            e.kind === "project" ||
            [
              ...contentDependencies(e).flatMap(([kind, id]) =>
                referenceEntries(manifest, e, kind, id)
              ),
              ...(manifest.modules?.milestones && e.draft?.milestone
                ? referenceEntries(
                    manifest,
                    e,
                    "milestone",
                    `${e.draft.project}::${e.draft.milestone}`
                  )
                : []),
              ...referenceEntries(
                manifest,
                e,
                "issue",
                e.draft?.parentId ?? ""
              ),
              ...referenceEntries(
                manifest,
                e,
                "project",
                e.draft?.project ?? ""
              ),
            ].every((other) => other.canonicalId || other.state === "skipped")
        )
        if (index < 0) {
          for (const entry of pending) {
            entry.state = "quarantined"
            entry.message =
              "Resolve the missing or circular parent/project reference, then retry unresolved records."
          }
          break
        }
        const [entry] = pending.splice(index, 1)
        try {
          let created = false
          let contentEvents: Array<{
            topic: string
            payload: Record<string, unknown>
          }> = []
          await tx.transaction(async (nested) => {
            if (!entry.sourceValid)
              throw new Error(
                "The source record is invalid. Correct its retained source before importing."
              )
            if (entry.content)
              await requireContentModule(nested, current, entry)
            const result = await reconcile(nested, current, manifest, entry)
            if (result.blocked) return
            if (result.skip) {
              entry.state = "skipped"
              return
            }
            if (result.convert) {
              entry.canonicalId = result.convert
              entry.replaceLegacyFiles = true
              entry.state = "saved"
              delete entry.reviewRequired
              entry.message =
                "Existing inline files will be converted to verified durable files; shared issue fields are preserved."
              await recordAlias(nested, current, entry, result.convert)
              entry.targetFingerprint = (await target(
                nested,
                current,
                entry,
                result.convert
              ))!.fingerprint
              return
            }
            if (result.reuse) {
              entry.canonicalId = result.reuse
              entry.state = "saved"
              delete entry.reviewRequired
              // Reuse never appends source files to an existing shared object.
              if (result.reviewed) {
                entry.message =
                  "Kept the existing shared record. This source version and its files remain in your private backup."
                manifest.exclusions.push(
                  `${entry.sourceKey}/${entry.path}: kept the reviewed shared version; source fields/files were not added.`
                )
              }
              if (result.reviewed) entry.files = []
              else if (entry.files.length) {
                const [existing] = await nested
                  .select({ properties: issues.properties })
                  .from(issues)
                  .where(eq(issues.id, result.reuse))
                entry.files = entry.files.map((source) => ({
                  ...source,
                  data: "",
                  fileId: existing?.properties.attachments?.find(
                    (file) =>
                      file.fileId &&
                      file.name === source.name &&
                      file.checksum === source.checksum &&
                      file.sizeBytes === source.sizeBytes
                  )?.fileId,
                }))
              }
              entry.targetFingerprint = (await target(
                nested,
                current,
                entry,
                result.reuse
              ))!.fingerprint
              return
            }
            if (entry.canonicalId) {
              const previous = entry.files
              entry.files = validatedImportFiles(entry.draft?.attachments).map(
                (file, index) => ({
                  ...file,
                  attempt: (previous[index]?.attempt ?? 0) + 1,
                })
              )
              entry.replaceLegacyFiles = false
            }
            const effect = await createEntry(
              nested,
              current,
              manifest,
              entry,
              Boolean(result.both)
            )
            entry.canonicalId = effect.id
            contentEvents = effect.events
            if (effect.changedProjectId) {
              for (const parent of manifest.entries.filter(
                (e) =>
                  e.kind === "project" &&
                  e.state === "saved" &&
                  e.canonicalId === effect.changedProjectId
              )) {
                parent.targetFingerprint = (await target(
                  nested,
                  current,
                  parent,
                  parent.canonicalId!
                ))!.fingerprint
                await recordAlias(nested, current, parent, parent.canonicalId!)
              }
            }
            entry.state = "saved"
            delete entry.reviewRequired
            entry.targetFingerprint = (await target(
              nested,
              current,
              entry,
              entry.canonicalId
            ))!.fingerprint
            delete entry.message
            created = true
          })
          events.push(...contentEvents)
          if (created && entry.kind === "issue")
            events.push({
              topic: "issue.created",
              payload: {
                issueId: entry.canonicalId,
                teamId: entry.teamId,
                history: { version: 1, origin: "import" },
              },
            })
        } catch (error) {
          entry.state = "quarantined"
          delete entry.canonicalId
          entry.message =
            error instanceof ApplicationAccessError
              ? "A referenced resource is unavailable."
              : error instanceof Error && !error.cause
                ? error.message
                : "This record could not be imported."
        }
      }
      await save(tx, manifest)
      return {
        value: { id: manifest.id },
        resource: { type: "legacyImport", id: manifest.id },
        events,
      }
    },
  })
  return readImport(actor, input.id)
}
export async function readImport(actor: Actor, id: string) {
  return db.transaction(async (tx) =>
    snapshot(await load(tx, await currentCommandActor(tx, actor), id), true)
  )
}
export async function chooseImportConflict(
  actor: Actor,
  raw: z.infer<typeof importChoiceSchema>
) {
  const input = importChoiceSchema.parse(raw)
  return db.transaction(async (tx) => {
    const current = await currentCommandActor(tx, actor),
      manifest = await load(tx, current, input.id)
    if (manifest.revision !== input.revision)
      throw new Error(
        "Import progress changed. Reload before reviewing this conflict."
      )
    const entry = manifest.entries.find((e) => e.id === input.entryId)
    if (
      !entry ||
      entry.state !== "review" ||
      entry.conflict?.fingerprint !== input.conflictFingerprint
    )
      throw new Error("Review the current conflict first.")
    entry.decision = {
      choice: input.choice,
      fingerprint: input.conflictFingerprint,
    }
    entry.state = "pending"
    await save(tx, manifest)
    return snapshot(manifest)
  })
}
export async function finalizeImportFile(
  actor: Actor,
  raw: z.infer<typeof importFileRequestSchema>
) {
  const input = importFileRequestSchema.parse(raw)
  await executeCommand({
    actor,
    commandKey: `import-file:${input.id}:${input.entryId}:${input.index}:${input.fileId}`,
    operation: "imports.file@1",
    input: {
      id: input.id,
      entryId: input.entryId,
      index: input.index,
      fileId: input.fileId,
    },
    status: 200,
    parse: (value) => z.object({ id: z.uuid() }).parse(value),
    authorize: async (tx, current) => {
      const manifest = await load(tx, current, input.id, false),
        entry = manifest.entries.find((e) => e.id === input.entryId)
      if (
        !entry?.canonicalId ||
        !(await target(tx, current, entry, entry.canonicalId))
      )
        throw new ApplicationAccessError()
    },
    run: async (tx, current) => {
      await tx.execute(
        sql`SELECT public.forge_lock_issue_graph(${current.workspaceId})`
      )
      const manifest = await load(tx, current, input.id),
        entry = manifest.entries.find((e) => e.id === input.entryId)
      if (
        !entry?.canonicalId ||
        entry.state !== "saved" ||
        entry.kind !== "issue"
      )
        throw new Error("The imported issue is unavailable.")
      const source = entry.files[input.index]
      if (!source || (!source.fileId && !entry.draft))
        throw new Error("The import file source is unavailable.")
      if (source.fileId)
        return {
          value: { id: manifest.id },
          resource: { type: "issue", id: entry.canonicalId },
          events: [],
        }
      if (manifest.revision !== input.revision)
        throw new Error("Import progress changed. Reload and resume.")
      const [row] = await tx
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.id, entry.canonicalId),
            readableIssueCondition(current, issues.id),
            isNull(issues.deletedAt),
            isNull(issues.archivedAt)
          )
        )
        .for("update")
      if (!row) throw new ApplicationAccessError()
      const [file] = await tx
        .select()
        .from(resourceFiles)
        .where(
          and(
            eq(resourceFiles.id, input.fileId),
            eq(resourceFiles.workspaceId, current.workspaceId)
          )
        )
      if (
        !file ||
        file.checksum !== source.checksum ||
        file.sizeBytes !== source.sizeBytes ||
        file.name !== source.name
      )
        throw new Error(
          "The uploaded file does not match the verified legacy bytes."
        )
      let existingAttachments = row.properties.attachments ?? []
      let legacyWidth = source.width
      let legacyAnchor = source.legacyId
      if (entry.replaceLegacyFiles) {
        const index = existingAttachments.findIndex((file) => {
          if (file.fileId) return false
          try {
            const [verified] = validatedImportFiles([file])
            return (
              verified.name === source.name &&
              verified.checksum === source.checksum &&
              verified.sizeBytes === source.sizeBytes
            )
          } catch {
            return false
          }
        })
        if (index < 0) {
          entry.state = "pending"
          await reconcile(tx, current, manifest, entry)
          entry.message =
            "The existing legacy file changed or was removed. Review the shared issue before retrying."
          await save(tx, manifest)
          return {
            value: { id: manifest.id },
            resource: { type: "issue", id: row.id },
            events: [],
          }
        }
        legacyWidth = existingAttachments[index].width
        legacyAnchor = issueAttachmentAnchor(existingAttachments[index])
        existingAttachments = existingAttachments.filter(
          (_, position) => position !== index
        )
      }
      const boundAttachments = await bindIssueFiles(
        tx,
        current,
        row.id,
        [input.fileId],
        existingAttachments
      )
      const attachments = boundAttachments.map((file) =>
        file.fileId === input.fileId
          ? {
              ...file,
              id: legacyAnchor ?? file.id,
              ...(legacyWidth ? { width: legacyWidth } : {}),
            }
          : file
      )
      await tx
        .update(issues)
        .set({ properties: { ...row.properties, attachments } })
        .where(eq(issues.id, row.id))
      source.fileId = input.fileId
      source.data = ""
      const updated = await target(tx, current, entry, row.id)
      if (
        entry.targetFingerprint ===
        commandInputHash(JSON.parse(JSON.stringify(row)))
      )
        entry.targetFingerprint = updated!.fingerprint
      await tx
        .update(legacyImportAliases)
        .set({ targetFingerprint: updated!.fingerprint })
        .where(
          and(
            aliasScope(current, entry),
            eq(legacyImportAliases.fingerprint, entry.fingerprint),
            eq(legacyImportAliases.canonicalId, row.id),
            eq(
              legacyImportAliases.targetFingerprint,
              commandInputHash(JSON.parse(JSON.stringify(row)))
            )
          )
        )
      await save(tx, manifest)
      return {
        value: { id: manifest.id },
        resource: { type: "issue", id: row.id },
        events: [
          {
            topic: "issue.file.attached",
            payload: {
              issueId: row.id,
              fileIds: [input.fileId],
              history: { version: 1, origin: "import" },
            },
          },
        ],
      }
    },
  })
  return readImport(actor, input.id)
}

/** Explicit user retry reviews the retained source; expired staging gets a new upload identity. */
export async function retryImportRecords(
  actor: Actor,
  raw: z.infer<typeof importRequestSchema>
) {
  const input = importRequestSchema.parse(raw)
  return db.transaction(async (tx) => {
    const current = await currentCommandActor(tx, actor)
    await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, current.workspaceId))
      .for("no key update")
    await tx.execute(
      sql`SELECT public.forge_lock_issue_graph(${current.workspaceId})`
    )
    const manifest = await load(tx, current, input.id)
    if (manifest.revision !== input.revision)
      throw new Error("Import progress changed. Refresh before retrying.")
    if (manifest.cleanedAt)
      throw new Error(
        "This import is completed and cleaned. New source data requires a new import."
      )
    // An explicit review can reopen an uncleaned settlement after normal shared edits.
    delete manifest.completedAt
    delete manifest.reconciliation
    const report = await importReconciliation(tx, current, manifest, true)
    const failed = new Set(report.discrepancies.map((d) => d.entryId))
    for (const entry of manifest.entries) {
      if (entry.state === "saved" && failed.has(entry.id)) {
        entry.state = "pending"
        entry.reviewRequired = true
        delete entry.decision
      }
      if (
        entry.state === "quarantined" &&
        entry.sourceValid &&
        (entry.draft || entry.project || entry.content)
      ) {
        entry.state = "pending"
        delete entry.message
      }
      for (const file of entry.files)
        if (!file.fileId) file.attempt = (file.attempt ?? 0) + 1
    }
    await save(tx, manifest)
    return snapshot(manifest)
  })
}

/** A failed automatic drive pauses durably; further attempts require an explicit user action. */
export async function pauseAutomaticImport(
  actor: Actor,
  raw: z.infer<typeof importRequestSchema>
) {
  const input = importRequestSchema.parse(raw)
  return db.transaction(async (tx) => {
    const current = await currentCommandActor(tx, actor),
      manifest = await load(tx, current, input.id)
    if (!manifest.automaticPaused) {
      manifest.automaticPaused = true
      await save(tx, manifest)
    }
    return snapshot(manifest)
  })
}

/** Source backup and canonical rows are checked under the same locks as import effects.
 * The report is evidence at a point in time, never a promise to freeze shared work. */
async function importReconciliation(
  tx: Transaction,
  actor: Actor,
  manifest: ImportManifest,
  full = false
): Promise<ImportReconciliation> {
  const discrepancies: ImportReconciliation["discrepancies"] = (
    manifest.sourceErrors ?? []
  ).map((message) => ({ message }))
  const counts = {
    sources: manifest.sources.length,
    records: manifest.entries.length,
    saved: 0,
    skipped: 0,
    unresolved: 0,
    files: 0,
    verifiedFiles: 0,
  }
  // Lock and recheck the recovery bytes after the workspace/graph fences; reads
  // during hydration alone cannot prevent concurrent backup replacement.
  for (const [index, source] of manifest.sources.entries()) {
    const [backup] = await tx
      .select()
      .from(productState)
      .where(
        and(
          eq(productState.workspaceId, actor.workspaceId),
          eq(productState.ownerId, `user:${actor.userId}`),
          eq(productState.key, sourceBackupKey(manifest.id, index))
        )
      )
      .for("share")
    try {
      const value = JSON.parse(JSON.parse(backup?.encodedValue ?? "null"))
      if (
        value.key !== source.key ||
        commandInputHash(value.value) !== source.checksum
      )
        throw new Error("checksum")
    } catch {
      discrepancies.push({
        message: "A private source backup is missing or its checksum differs.",
      })
    }
  }
  const observed: Array<unknown> = []
  for (const entry of [...manifest.entries].sort((a, b) =>
    (a.canonicalId ?? a.id).localeCompare(b.canonicalId ?? b.id)
  )) {
    const fail = (message: string) =>
      discrepancies.push({ entryId: entry.id, message })
    if (entry.state === "skipped") {
      counts.skipped++
      continue
    }
    if (entry.state !== "saved" || !entry.canonicalId) {
      counts.unresolved++
      fail(entry.message ?? "A source record still needs import or review.")
      continue
    }
    counts.saved++
    const live = await target(tx, actor, entry, entry.canonicalId, true)
    observed.push([entry.id, live?.fingerprint ?? null])
    // Pre-FOR-57 imports can use their original alias checkpoint, never today's row as an implicit acceptance.
    const [alias] = entry.targetFingerprint
      ? []
      : await tx
          .select()
          .from(legacyImportAliases)
          .where(
            and(
              aliasScope(actor, entry),
              eq(legacyImportAliases.fingerprint, entry.fingerprint),
              eq(legacyImportAliases.canonicalId, entry.canonicalId)
            )
          )
    const expected = entry.targetFingerprint ?? alias?.targetFingerprint
    if (!live || !expected || live.fingerprint !== expected)
      fail(
        "The shared record changed or is unavailable. Retry unresolved records to review the current version."
      )
    if (
      entry.kind === "issue" &&
      live &&
      entry.decision?.choice !== "keep-server" &&
      !entry.replaceLegacyFiles
    ) {
      try {
        const parentId =
          (await reference(
            tx,
            actor,
            manifest,
            entry,
            "issue",
            entry.draft?.parentId ?? ""
          )) || null
        const projectId =
          (await reference(
            tx,
            actor,
            manifest,
            entry,
            "project",
            entry.draft?.project ?? ""
          )) || null
        const milestoneId =
          manifest.modules?.milestones && entry.draft?.milestone
            ? await reference(
                tx,
                actor,
                manifest,
                entry,
                "milestone",
                `${entry.draft.project}::${entry.draft.milestone}`
              )
            : undefined
        if (
          (milestoneId !== undefined &&
            live.relationships?.milestoneId !== milestoneId) ||
          live.relationships?.parentId !== parentId ||
          live.relationships.projectId !== projectId
        )
          fail(
            "Canonical parent or project relationships differ from the source mapping."
          )
      } catch {
        fail("A source relationship is missing, ambiguous or unavailable.")
      }
    }
    if (entry.content && entry.decision?.choice !== "keep-server") {
      try {
        if (
          !(await contentRelationshipsMatch(
            tx,
            actor,
            entry,
            entry.canonicalId,
            (kind, id) => reference(tx, actor, manifest, entry, kind, id)
          ))
        )
          fail(
            "Canonical content relationships differ from the source mapping."
          )
      } catch {
        fail("A content relationship is missing, ambiguous or unavailable.")
      }
    }
    for (const file of entry.files) {
      counts.files++
      if (!file.fileId) {
        fail("A source file has not been verified and attached.")
        continue
      }
      const [bound] = await tx
        .select()
        .from(resourceFiles)
        .where(
          and(
            eq(resourceFiles.id, file.fileId),
            eq(resourceFiles.workspaceId, actor.workspaceId)
          )
        )
        .for("share")
      observed.push([
        file.fileId,
        bound?.checksum,
        bound?.attachmentState,
        bound?.deletedAt,
      ])
      const [issue] = await tx
        .select({ properties: issues.properties })
        .from(issues)
        .where(eq(issues.id, entry.canonicalId))
      if (
        !bound ||
        bound.issueId !== entry.canonicalId ||
        bound.deletedAt ||
        bound.attachmentState !== "attached" ||
        bound.commentId ||
        bound.checksum !== file.checksum ||
        bound.sizeBytes !== file.sizeBytes ||
        bound.name !== file.name ||
        !issue?.properties.attachments?.some(
          (f) =>
            f.fileId === file.fileId &&
            f.checksum === file.checksum &&
            f.sizeBytes === file.sizeBytes &&
            !f.data
        )
      )
        fail(
          "An attached file is missing or differs from its verified source checksum."
        )
      else counts.verifiedFiles++
    }
  }
  const body = {
    manifest: manifest.fingerprint,
    counts,
    discrepancies,
    observed,
    exclusions: manifest.exclusions,
  }
  return {
    fingerprint: commandInputHash(JSON.parse(JSON.stringify(body))),
    checkedAt: new Date().toISOString(),
    ready: !discrepancies.length,
    counts,
    discrepancyCount: discrepancies.length,
    discrepancies: full ? discrepancies : discrepancies.slice(0, 100),
    retainedExclusions: manifest.exclusions.length + counts.skipped,
  }
}

/** Explicit settlement never enables browser writes. Canonical authority is already
 * atomically installed by IssueDefinitionProvider for this authenticated scope. */
export async function cutoverImport(
  actor: Actor,
  raw: z.infer<typeof importCutoverSchema>
) {
  const input = importCutoverSchema.parse(raw)
  await executeCommand({
    actor,
    commandKey: `import-cutover:${input.id}:${input.revision}:${input.action}`,
    operation: "imports.cutover@1",
    input: {
      id: input.id,
      revision: input.revision,
      action: input.action,
      reportFingerprint: input.reportFingerprint ?? null,
      acknowledgeExclusions: input.acknowledgeExclusions,
    },
    status: 200,
    parse: (value) => z.object({ id: z.uuid() }).parse(value),
    authorize: async (tx, current) => {
      await load(tx, current, input.id, false)
    },
    run: async (tx, current) => {
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, current.workspaceId))
        .for("no key update")
      await tx.execute(
        sql`SELECT public.forge_lock_issue_graph(${current.workspaceId})`
      )
      const manifest = await load(tx, current, input.id)
      if (manifest.revision !== input.revision)
        throw new Error("Import progress changed. Refresh and reconcile again.")
      const report = await importReconciliation(tx, current, manifest)
      if (input.action !== "reconcile") {
        if (!report.ready)
          throw new Error(
            "Unresolved discrepancies block completion and cleanup. Reconcile and review the report."
          )
        if (input.reportFingerprint !== report.fingerprint)
          throw new Error(
            "Reconciliation changed. Check the latest report before continuing."
          )
        if (report.retainedExclusions && !input.acknowledgeExclusions)
          throw new Error(
            "Acknowledge the excluded and skipped data retained in your private backups."
          )
        manifest.completedAt ??= new Date().toISOString()
      }
      if (input.action === "cleanup") {
        if (!manifest.cleanedAt) {
          // Remove only redundant issue records; team preferences/history and advanced
          // workspace planning stay intact. Exact CAS never erases a later source.
          manifest.cleanedSources = []
          for (const source of manifest.sources) {
            if (!/^forge:(team|triage|cycle)-issues:v1:/.test(source.key))
              continue
            const predicate = and(
              eq(productState.workspaceId, current.workspaceId),
              eq(productState.ownerId, `user:${current.userId}`),
              eq(productState.key, source.key)
            )
            const [row] = await tx
              .select()
              .from(productState)
              .where(predicate)
              .for("update")
            if (!row?.encodedValue) continue
            const raw = JSON.parse(row.encodedValue)
            if (commandInputHash(raw) !== source.checksum) continue
            const body = JSON.parse(raw)
            if (source.key.startsWith("forge:team-issues:v1:")) {
              const teamId = source.key.slice("forge:team-issues:v1:".length)
              const favorites = manifest.entries
                .filter(
                  (e) =>
                    e.sourceKey === source.key &&
                    e.sourceChecksum === source.checksum &&
                    e.draft?.favorite &&
                    e.canonicalId
                )
                .map((e) => e.canonicalId!)
              // Preserve the existing star projection before removing its legacy fallback.
              // A newer explicit favorite selection always wins, including an empty list.
              await tx
                .insert(productState)
                .values({
                  workspaceId: current.workspaceId,
                  ownerId: `user:${current.userId}`,
                  ownerUserId: current.userId,
                  teamId,
                  key: `forge:team-issue-favorites:v1:${teamId}`,
                  encodedValue: JSON.stringify(JSON.stringify(favorites)),
                })
                .onConflictDoNothing()
            }
            const cleaned = JSON.stringify(
              Array.isArray(body) ? [] : { ...body, issues: [] }
            )
            await tx
              .update(productState)
              .set({
                encodedValue: JSON.stringify(cleaned),
                revision: row.revision + 1,
              })
              .where(predicate)
            manifest.cleanedSources.push({
              key: source.key,
              checksum: commandInputHash(cleaned),
            })
          }
          manifest.cleanedAt = new Date().toISOString()
        }
      }
      manifest.reconciliation = report
      await save(tx, manifest)
      return {
        value: { id: manifest.id },
        resource: { type: "legacyImport", id: manifest.id },
        events: [
          {
            topic: "imports.reconciled",
            payload: {
              importId: manifest.id,
              action: input.action,
              ready: report.ready,
            },
          },
        ],
      }
    },
  })
  return readImport(actor, input.id)
}

/** Complete, authenticated reject report; source bodies remain in private backups. */
export async function downloadImportReport(actor: Actor, id: string) {
  return db.transaction(async (tx) => {
    const current = await currentCommandActor(tx, actor)
    await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, current.workspaceId))
      .for("no key update")
    await tx.execute(
      sql`SELECT public.forge_lock_issue_graph(${current.workspaceId})`
    )
    const manifest = await load(tx, current, id)
    return {
      version: 1,
      id,
      workspaceId: current.workspaceId,
      actorId: current.userId,
      authority: "canonical-server",
      completedAt: manifest.completedAt,
      cleanedAt: manifest.cleanedAt,
      report: await importReconciliation(tx, current, manifest, true),
      sources: manifest.sources.map(({ key, checksum }) => ({ key, checksum })),
      records: manifest.entries.map(
        ({ id, sourceKey, path, legacyId, canonicalId, state }) => ({
          id,
          sourceKey,
          path,
          legacyId,
          canonicalId,
          state,
        })
      ),
      exclusions: manifest.exclusions,
    }
  })
}
