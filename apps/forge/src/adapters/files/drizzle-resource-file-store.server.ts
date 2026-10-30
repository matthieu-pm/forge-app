import "@tanstack/react-start/server-only"
import { and, eq, isNull } from "drizzle-orm"
import type {
  ResourceFileMetadataStore,
  StoredResourceFile,
} from "@/application/files/resource-file-store"
import { db, documents, issues, resourceFiles } from "@/db"

function toRecord(row: typeof resourceFiles.$inferSelect): StoredResourceFile {
  const { issueId, documentId, ...record } = row
  return {
    ...record,
    resource: issueId
      ? { kind: "issue", id: issueId }
      : { kind: "document", id: documentId! },
  }
}
export class DrizzleResourceFileStore implements ResourceFileMetadataStore {
  async create(input: StoredResourceFile) {
    const { resource, ...record } = input
    return db.transaction(async (tx) => {
      // Internal imports use this store as well as direct-upload publication.
      // Keep their final metadata write atomic against issue deletion after an
      // asynchronous byte upload; authorization before uploading is insufficient.
      let issueId = resource.kind === "issue" ? resource.id : null
      if (resource.kind === "document") {
        const document = (
          await tx
            .select()
            .from(documents)
            .where(
              and(
                eq(documents.workspaceId, input.workspaceId),
                eq(documents.id, resource.id)
              )
            )
            .for("share")
        ).at(0)
        if (!document)
          throw new Error("The file's resource is no longer available.")
        if (!document.sharedWithWorkspace) issueId = document.issueId
      }
      if (issueId) {
        const issue = (
          await tx
            .select({ id: issues.id })
            .from(issues)
            .where(
              and(
                eq(issues.workspaceId, input.workspaceId),
                eq(issues.id, issueId),
                isNull(issues.deletedAt),
                isNull(issues.archivedAt),
                isNull(issues.purgedAt)
              )
            )
            .for("share")
        ).at(0)
        if (!issue)
          throw new Error("The file's resource is no longer available.")
      }
      const rows = await tx
        .insert(resourceFiles)
        .values({
          ...record,
          issueId: resource.kind === "issue" ? resource.id : null,
          documentId: resource.kind === "document" ? resource.id : null,
        })
        .returning()
      const row = rows.at(0)
      if (!row) throw new Error("File metadata was not stored.")
      return toRecord(row)
    })
  }
  async get(workspaceId: string, fileId: string) {
    const rows = await db
      .select()
      .from(resourceFiles)
      .where(
        and(
          eq(resourceFiles.workspaceId, workspaceId),
          eq(resourceFiles.id, fileId)
        )
      )
      .limit(1)
    const row = rows.at(0)
    return row ? toRecord(row) : null
  }
}
