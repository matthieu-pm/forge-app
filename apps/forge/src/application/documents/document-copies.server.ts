import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type { DocumentFields, DocumentSource } from "@/lib/document-contract"
import { documents, productState, projects } from "@/db"
import {
  matchesReviewedLegacyDocument,
  retainCanonicalDocumentCopies,
} from "@/lib/document-copy-recovery"

export class LegacyDocumentConflict extends Error {}

/** Canonical IDs (including tombstones) cannot be republished; raw copies stay recoverable. */
export async function pruneTeamDocumentCopies(
  tx: Transaction,
  actor: Actor,
  key: string,
  value: string | null,
  previous: string | null = null
) {
  const teamId = key.match(/^forge:team-home:v1:([0-9a-f-]{36})$/)?.[1]
  if (!teamId) return value
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
  return retainCanonicalDocumentCopies(value, previous, ids)
}
function matchingCopies(resources: Array<unknown>, documentId: string) {
  return resources.filter(
    (resource) =>
      resource &&
      typeof resource === "object" &&
      "id" in resource &&
      resource.id === documentId
  )
}
function requireReviewedSource(
  resources: Array<unknown>,
  documentId: string,
  fields: DocumentFields,
  kind: "team" | "project"
) {
  const copies = matchingCopies(resources, documentId)
  if (copies.some((copy) => !matchesReviewedLegacyDocument(copy, fields, kind)))
    throw new LegacyDocumentConflict(
      "The legacy document changed. Refresh and review its latest content before importing."
    )
  return copies
}
export async function consumeLegacyDocumentCopy(
  tx: Transaction,
  actor: Actor,
  source: DocumentSource,
  documentId: string,
  fields: DocumentFields,
  legacyImport = false
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
    let found = false
    for (const row of rows) {
      if (!row.encodedValue) continue
      const state = JSON.parse(JSON.parse(row.encodedValue)) as Record<
        string,
        unknown
      >
      if (!Array.isArray(state.resources))
        throw new LegacyDocumentConflict(
          "The legacy source could not be reviewed. Its original copy is preserved."
        )
      const copies = requireReviewedSource(
        state.resources,
        documentId,
        fields,
        "team"
      )
      if (!copies.length) continue
      if (!legacyImport)
        throw new LegacyDocumentConflict(
          "Import the preserved source explicitly before replacing it."
        )
      found = true
      // Only the selected, exact source is consumed. Other documents and recovery copies are unchanged.
      const next = {
        ...state,
        resources: state.resources.filter(
          (resource) => !copies.includes(resource)
        ),
      }
      await tx
        .update(productState)
        .set({
          encodedValue: JSON.stringify(JSON.stringify(next)),
          revision: row.revision + 1,
        })
        .where(eq(productState.id, row.id))
    }
    if (legacyImport && !found)
      throw new LegacyDocumentConflict(
        "The legacy document was removed. Refresh before importing."
      )
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
    if (!Array.isArray(resources)) {
      if (legacyImport)
        throw new LegacyDocumentConflict(
          "The legacy document was removed. Refresh before importing."
        )
      return
    }
    const copies = requireReviewedSource(
      resources,
      documentId,
      fields,
      "project"
    )
    if (!copies.length) {
      if (legacyImport)
        throw new LegacyDocumentConflict(
          "The legacy document was removed. Refresh before importing."
        )
      return
    }
    if (!legacyImport)
      throw new LegacyDocumentConflict(
        "Import the preserved source explicitly before replacing it."
      )
    await tx
      .update(projects)
      .set({
        properties: {
          ...row.properties,
          resources: resources.filter((resource) => !copies.includes(resource)),
        },
        revision: row.revision + 1,
      })
      .where(eq(projects.id, row.id))
  } else if (legacyImport)
    throw new LegacyDocumentConflict(
      "This resource has no reviewed legacy document source."
    )
}
