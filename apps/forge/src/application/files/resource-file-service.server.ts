import "@tanstack/react-start/server-only"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { fileChecksum, fileContentMatches } from "./file-integrity.server"
import type { FileBlobStore } from "./blob-store"
import type {
  FileResource,
  ResourceFileMetadataStore,
  StoredResourceFile,
} from "./resource-file-store"
import type { Actor } from "@/application/actor"

const resourceSchema = z
  .object({ kind: z.enum(["issue", "document"]), id: z.uuid() })
  .strict()
const inputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^/\\\r\n\0]+$/),
  contentType: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
})
function publicRecord(record: StoredResourceFile) {
  const {
    storageReference: _reference,
    workspaceId: _workspace,
    createdByUserId: _owner,
    ...file
  } = record
  return file
}

/** Internal persistence seam. Resource adapters must supply live read/write policy.
 * Upload intents/UI binding/download transport are separate consumers, never bypasses.
 */
export class ResourceFileService {
  constructor(
    private readonly dependencies: {
      metadata: ResourceFileMetadataStore
      blobs: FileBlobStore
      authorize: (
        actor: Actor,
        resource: FileResource,
        action: "read" | "write"
      ) => Promise<void>
      authorizeUpload?: (actor: Actor, contentType: string) => Promise<void>
      maxBytes?: number
    }
  ) {}

  async create(
    actor: Actor,
    rawResource: FileResource,
    input: { name: string; contentType: string; content: Uint8Array }
  ) {
    const resource = resourceSchema.parse(rawResource)
    const metadata = inputSchema.parse(input)
    await this.dependencies.authorize(actor, resource, "write")
    await this.dependencies.authorizeUpload?.(actor, metadata.contentType)
    // Snapshot caller-owned bytes before asynchronous persistence.
    const content = new Uint8Array(input.content)
    const maxBytes = this.dependencies.maxBytes ?? 5 * 1024 * 1024
    if (content.byteLength === 0 || content.byteLength > maxBytes)
      throw new Error("Invalid file size.")
    const record: StoredResourceFile = {
      ...metadata,
      id: randomUUID(),
      workspaceId: actor.workspaceId,
      createdByUserId: actor.userId,
      resource,
      sizeBytes: content.byteLength,
      checksum: fileChecksum(content),
      // Independent from resource IDs, user names, filenames and UI identifiers.
      storageReference: `files/${randomUUID()}`,
      createdAt: new Date(),
      deletedAt: null,
    }
    await this.dependencies.blobs.put(record.storageReference, content)
    try {
      return publicRecord(await this.dependencies.metadata.create(record))
    } catch (error) {
      await this.dependencies.blobs
        .delete(record.storageReference)
        .catch(() => {})
      throw error
    }
  }

  async read(actor: Actor, fileId: string) {
    z.uuid().parse(fileId)
    const record = await this.dependencies.metadata.get(
      actor.workspaceId,
      fileId
    )
    if (!record || record.workspaceId !== actor.workspaceId || record.deletedAt)
      throw new Error("File not found.")
    await this.dependencies.authorize(actor, record.resource, "read")
    const content = await this.dependencies.blobs.get(record.storageReference)
    if (!content || !fileContentMatches(content, record))
      throw new Error(
        "File content is unavailable or failed its integrity check."
      )
    return { file: publicRecord(record), content }
  }
}
