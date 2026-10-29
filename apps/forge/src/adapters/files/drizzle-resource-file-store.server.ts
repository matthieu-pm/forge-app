import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import type {
  ResourceFileMetadataStore,
  StoredResourceFile,
} from "@/application/files/resource-file-store"
import { db, resourceFiles } from "@/db"

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
    const rows = await db
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
