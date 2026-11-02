import "@tanstack/react-start/server-only"
import { and, desc, eq, isNull } from "drizzle-orm"
import { z } from "zod"
import {
  LegacyDocumentConflict,
  consumeLegacyDocumentCopy,
} from "./document-copies.server"
import type { JSONContent } from "@tiptap/core"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type {
  DocumentCommandResult,
  DocumentFields,
  DocumentRevision,
  DocumentSource,
  SharedDocument,
} from "@/lib/document-contract"
import { db, documentRevisions, documents, organizations, users } from "@/db"
import {
  ApplicationAccessError,
  hasWorkspaceRole,
} from "@/application/authorization"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { executeCommand } from "@/application/commands/execute-command.server"
import {
  readableDocumentCondition,
  readableIssueCondition,
  readableProjectCondition,
  readableTeamCondition,
} from "@/application/resource-policy.server"
import {
  documentBodySchema,
  documentCommandSchema,
  documentFieldsSchema,
  documentIconSchema,
  documentSourceSchema,
} from "@/lib/document-contract"
import { defaultDocumentIcon, documentPlainText } from "@/lib/team-documents"

function session(actor: Actor) {
  const enabled =
    process.env.FORGE_SHARED_DOCUMENTS_ENABLED ??
    (process.env.FORGE_SERVICE_ENVIRONMENT === "production" ? "false" : "true")
  if (enabled !== "true")
    throw new ApplicationAccessError(
      "Shared documents are not enabled in this environment."
    )
  if (actor.authentication.kind !== "session" || actor.scopes !== null)
    throw new ApplicationAccessError(
      "Document transports require a first-party session."
    )
}
async function lockWorkspace(tx: Transaction, actor: Actor) {
  // The same guard as project/issue mutations serializes source visibility changes.
  await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, actor.workspaceId))
    .for("no key update")
}
async function sourceAccess(
  tx: Transaction,
  actor: Actor,
  source: DocumentSource
) {
  session(actor)
  if (source.kind === "workspace") return
  const { teams, projects, issues, teamMembers } = await import("@/db")
  // Membership and source are locked through commit, including on receipt replay.
  await tx
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.workspaceId, actor.workspaceId),
        eq(teamMembers.userId, actor.userId)
      )
    )
    .for("share")
  const table =
    source.kind === "team"
      ? teams
      : source.kind === "project"
        ? projects
        : issues
  const condition =
    source.kind === "team"
      ? readableTeamCondition(actor, table.id)
      : source.kind === "project"
        ? readableProjectCondition(actor, table.id)
        : readableIssueCondition(actor, table.id)
  if (
    !(
      await tx
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.id, source.id!), condition))
        .for("share")
    )[0]
  )
    throw new ApplicationAccessError()
}
async function accessible(
  tx: Transaction,
  actor: Actor,
  id: string,
  includeDeleted = false
) {
  session(actor)
  const row = (
    await tx
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.id, id),
          eq(documents.workspaceId, actor.workspaceId),
          includeDeleted
            ? undefined
            : readableDocumentCondition(actor, documents.id),
          includeDeleted ? undefined : isNull(documents.deletedAt)
        )
      )
      .for("share")
  )[0]
  if (!row) throw new ApplicationAccessError()
  if (!row.sharedWithWorkspace)
    await sourceAccess(
      tx,
      actor,
      row.teamId
        ? { kind: "team", id: row.teamId }
        : row.projectId
          ? { kind: "project", id: row.projectId }
          : row.issueId
            ? { kind: "issue", id: row.issueId }
            : { kind: "workspace" }
    )
  return row
}
async function person(tx: Transaction, id: string | null) {
  return id
    ? ((
        await tx
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(eq(users.id, id))
      )[0] ?? null)
    : null
}
function safeFields(row: {
  title: string
  body: unknown
  icon: unknown
  sectionId: string | null
}) {
  const body = documentBodySchema.safeParse(row.body)
  return {
    title: row.title,
    body: body.success ? body.data : (row.body as JSONContent),
    icon: documentIconSchema.safeParse(row.icon).data ?? defaultDocumentIcon,
    sectionId: row.sectionId,
    ...(!body.success ? { unsafeBody: true } : {}),
  }
}
async function project(
  tx: Transaction,
  actor: Actor,
  row: typeof documents.$inferSelect
): Promise<SharedDocument> {
  return {
    ...safeFields(row),
    id: row.id,
    revision: row.revision,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    owner: await person(tx, row.ownerId),
    updatedBy: await person(tx, row.updatedById),
    canDelete:
      row.ownerId === actor.userId ||
      hasWorkspaceRole(actor, ["owner", "admin"]),
    canShare: hasWorkspaceRole(actor, ["owner", "admin"]),
    sharedWithWorkspace: row.sharedWithWorkspace,
  }
}
export async function readDocuments(
  actor: Actor,
  input: { source?: DocumentSource; id?: string }
) {
  session(actor)
  if (input.id) z.uuid().parse(input.id)
  if (input.source) documentSourceSchema.parse(input.source)
  return db.transaction(async (tx) => {
    actor = await currentCommandActor(tx, actor)
    await lockWorkspace(tx, actor)
    if (input.id)
      return [await project(tx, actor, await accessible(tx, actor, input.id))]
    if (!input.source) throw new ApplicationAccessError()
    await sourceAccess(tx, actor, input.source)
    const source = input.source
    const rows = await tx
      .select()
      .from(documents)
      .where(
        and(
          readableDocumentCondition(actor, documents.id),
          isNull(documents.deletedAt),
          source.kind === "team"
            ? eq(documents.teamId, source.id!)
            : source.kind === "project"
              ? eq(documents.projectId, source.id!)
              : source.kind === "issue"
                ? eq(documents.issueId, source.id!)
                : undefined
        )
      )
      .orderBy(desc(documents.updatedAt), documents.id)
    return Promise.all(rows.map((row) => project(tx, actor, row)))
  })
}
export async function readDocumentHistory(
  actor: Actor,
  id: string,
  before?: number
) {
  z.uuid().parse(id)
  return db.transaction(async (tx) => {
    actor = await currentCommandActor(tx, actor)
    await lockWorkspace(tx, actor)
    await accessible(tx, actor, id)
    const { lt } = await import("drizzle-orm")
    const rows = await tx
      .select()
      .from(documentRevisions)
      .where(
        and(
          eq(documentRevisions.documentId, id),
          eq(documentRevisions.workspaceId, actor.workspaceId),
          before ? lt(documentRevisions.revision, before) : undefined
        )
      )
      .orderBy(desc(documentRevisions.revision))
      .limit(30)
    return Promise.all(
      rows.map(
        async (row) =>
          ({
            ...safeFields(row.snapshot as DocumentFields),
            revision: row.revision,
            createdAt: row.createdAt.toISOString(),
            author: await person(tx, row.authorId),
          }) satisfies DocumentRevision
      )
    )
  })
}
class RevisionConflict extends Error {}
export async function commandDocument(
  actor: Actor,
  commandKey: string,
  raw: unknown
): Promise<DocumentCommandResult> {
  session(actor)
  z.uuid().parse(commandKey)
  const input = documentCommandSchema.parse(raw)
  try {
    const result = await executeCommand({
      actor,
      commandKey,
      operation: "documents.write@1",
      input,
      status: 200,
      parse: (value) =>
        z
          .object({ id: z.uuid(), revision: z.number().int().positive() })
          .strict()
          .parse(value),
      authorize: async (tx, current, saved) => {
        await lockWorkspace(tx, current)
        if (input.action === "create") {
          await sourceAccess(tx, current, input.source)
          // Creation receipts return caller-known identity/revision only. A deleted
          // tombstone can confirm an uncertain create after current source authority
          // is rechecked above, without exposing deleted content or recreating it.
          if (saved) await accessible(tx, current, saved.id, true)
        } else {
          const row = await accessible(
            tx,
            current,
            input.id,
            input.action === "delete"
          )
          if (
            input.action === "delete" &&
            row.ownerId !== current.userId &&
            !hasWorkspaceRole(current, ["owner", "admin"])
          )
            throw new ApplicationAccessError()
          if (
            input.action === "share" &&
            !hasWorkspaceRole(current, ["owner", "admin"])
          )
            throw new ApplicationAccessError()
        }
      },
      run: async (tx, current) => {
        const old = (
          await tx
            .select()
            .from(documents)
            .where(
              and(
                eq(documents.id, input.id),
                eq(documents.workspaceId, current.workspaceId)
              )
            )
            .for("update")
        )[0]
        if (
          input.action === "create"
            ? Boolean(old)
            : !old ||
              Boolean(old.deletedAt) ||
              old.revision !== input.expectedRevision
        )
          throw new RevisionConflict()
        const now = new Date(),
          revision = (old?.revision ?? 0) + 1
        let fields: DocumentFields
        if (input.action === "restore") {
          const saved = (
            await tx
              .select()
              .from(documentRevisions)
              .where(
                and(
                  eq(documentRevisions.workspaceId, current.workspaceId),
                  eq(documentRevisions.documentId, input.id),
                  eq(documentRevisions.revision, input.revision)
                )
              )
          )[0]
          if (!saved) throw new ApplicationAccessError()
          fields = documentFieldsSchema.parse(saved.snapshot)
        } else if (input.action === "save" || input.action === "create")
          fields = input.fields
        else
          fields = {
            title: old.title,
            body: old.body,
            icon: old.icon,
            sectionId: old.sectionId,
          }
        const values = {
          ...fields,
          body: fields.body as Record<string, unknown>,
          content:
            input.action === "delete" || input.action === "share"
              ? old.content
              : documentPlainText(fields.body),
          revision,
          updatedAt: now,
          updatedById: current.userId,
        }
        if (input.action === "create")
          await tx.insert(documents).values({
            ...values,
            id: input.id,
            workspaceId: current.workspaceId,
            ownerId: current.userId,
            createdAt: now,
            teamId: input.source.kind === "team" ? input.source.id : null,
            projectId: input.source.kind === "project" ? input.source.id : null,
            issueId: input.source.kind === "issue" ? input.source.id : null,
          })
        else
          await tx
            .update(documents)
            .set({
              ...values,
              ...(input.action === "delete" ? { deletedAt: now } : {}),
              ...(input.action === "share"
                ? { sharedWithWorkspace: input.shared }
                : {}),
            })
            .where(eq(documents.id, input.id))
        if (input.action === "create")
          await consumeLegacyDocumentCopy(
            tx,
            current,
            input.source,
            input.id,
            input.fields,
            input.legacyImport === true
          )
        await tx.insert(documentRevisions).values({
          workspaceId: current.workspaceId,
          documentId: input.id,
          revision,
          snapshot: fields as Record<string, unknown>,
          authorId: current.userId,
          createdAt: now,
        })
        return {
          value: { id: input.id, revision },
          resource: { type: "document", id: input.id },
          events: [
            {
              topic: `document.${input.action}`,
              payload: { documentId: input.id, revision },
            },
          ],
        }
      },
    })
    return { status: "saved", ...result.value }
  } catch (error) {
    if (
      !(error instanceof RevisionConflict) &&
      !(error instanceof LegacyDocumentConflict)
    )
      throw error
    // Conflict itself has no durable effect or receipt. Reauthorize the fresh view.
    const current = await readDocuments(actor, { id: input.id }).catch(() => [])
    return { status: "conflict", current: current[0] ?? null }
  }
}
