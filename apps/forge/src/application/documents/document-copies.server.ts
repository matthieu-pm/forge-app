import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type { DocumentSource } from "@/lib/document-contract"
import { documents, productState, projects } from "@/db"

/** Canonical identities (including tombstones) cannot be republished by an old snapshot. */
export async function pruneTeamDocumentCopies(
  tx: Transaction,
  actor: Actor,
  key: string,
  value: string | null
) {
  const teamId = key.match(/^forge:team-home:v1:([0-9a-f-]{36})$/)?.[1]
  if (!teamId || value === null) return value
  const ids = new Set(
    (
      await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.workspaceId, actor.workspaceId),
            eq(documents.teamId, teamId)
          )
        )
    ).map((d) => d.id)
  )
  if (!ids.size) return value
  const state = JSON.parse(value)
  if (!Array.isArray(state.resources))
    throw new Error("Invalid team resource snapshot.")
  return JSON.stringify({
    ...state,
    resources: state.resources.filter(
      (r: { id: string; kind: string }) =>
        r.kind !== "document" || !ids.has(r.id)
    ),
  })
}
export async function consumeLegacyDocumentCopy(
  tx: Transaction,
  actor: Actor,
  source: DocumentSource,
  documentId: string
) {
  if (source.kind === "team") {
    const key = `forge:team-home:v1:${source.id}`
    const rows = await tx
      .select()
      .from(productState)
      .where(
        and(
          eq(productState.workspaceId, actor.workspaceId),
          eq(productState.ownerId, `user:${actor.userId}`),
          eq(productState.key, key)
        )
      )
      .for("update")
    for (const row of rows) {
      if (!row.encodedValue) continue
      const before = JSON.parse(row.encodedValue) as string
      const next = await pruneTeamDocumentCopies(tx, actor, key, before)
      if (next !== before)
        await tx
          .update(productState)
          .set({
            encodedValue: JSON.stringify(next),
            revision: row.revision + 1,
          })
          .where(eq(productState.id, row.id))
    }
  } else if (source.kind === "project") {
    const row = (
      await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.workspaceId, actor.workspaceId),
            eq(projects.id, source.id!)
          )
        )
        .for("update")
    )[0]
    const resources = row?.properties.resources
    if (
      row &&
      Array.isArray(resources) &&
      resources.some((r) => r.id === documentId && !r.url)
    )
      await tx
        .update(projects)
        .set({
          properties: {
            ...row.properties,
            resources: resources.filter((r) => r.id !== documentId || r.url),
          },
          revision: row.revision + 1,
        })
        .where(eq(projects.id, row.id))
  }
}
