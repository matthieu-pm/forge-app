import "@tanstack/react-start/server-only"
import {
  FILE_DELIVERY_MAX_BYTES,
  FILE_GRANT_SECONDS,
  FILE_PREVIEW_MAX_BYTES,
  FileDeliveryError,
  fileTargetSchema,
} from "./file-delivery-contract"
import { mintFileGrant, verifyFileGrant } from "./file-grant.server"
import { fileContentMatches } from "./file-integrity.server"
import type { FilePurpose, FileTarget } from "./file-delivery-contract"
import type { FileBlobStore } from "./blob-store"
import type { Actor } from "../actor"

export type DeliveryFile = {
  id: string
  name: string
  contentType: string
  sizeBytes: number
  checksum: string
  storageReference: string
}
export type AuthorizedFileLookup = (
  actor: Actor,
  target: FileTarget
) => Promise<DeliveryFile | null>

export class FileDeliveryService {
  constructor(
    private readonly deps: {
      lookup: AuthorizedFileLookup
      blobs: FileBlobStore
      now?: () => Date
    }
  ) {}
  private async metadata(actor: Actor, raw: FileTarget) {
    const target = fileTargetSchema.parse(raw)
    if (actor.authentication.kind !== "session" || actor.scopes !== null)
      throw new FileDeliveryError("FILE_NOT_FOUND")
    const file = await this.deps.lookup(actor, target)
    if (!file) throw new FileDeliveryError("FILE_NOT_FOUND")
    return file
  }
  async grant(actor: Actor, target: FileTarget, purpose: FilePurpose) {
    const file = await this.metadata(actor, target)
    if (purpose === "preview" && file.sizeBytes > FILE_PREVIEW_MAX_BYTES)
      throw new FileDeliveryError("PREVIEW_UNAVAILABLE")
    const token = await mintFileGrant(actor, target, purpose, this.deps.now?.())
    return {
      file: {
        id: file.id,
        name: file.name,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
      },
      url: `/api/files/${target.kind}/${target.id}/${purpose}?token=${encodeURIComponent(token)}`,
      expiresInSeconds: FILE_GRANT_SECONDS,
    }
  }
  async read(
    actor: Actor,
    target: FileTarget,
    purpose: FilePurpose,
    token: string
  ) {
    await verifyFileGrant(token, actor, target, purpose, this.deps.now?.())
    const file = await this.metadata(actor, target)
    const maxBytes =
      purpose === "preview" ? FILE_PREVIEW_MAX_BYTES : FILE_DELIVERY_MAX_BYTES
    if (
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      file.sizeBytes > maxBytes
    )
      throw new FileDeliveryError(
        purpose === "preview" ? "PREVIEW_UNAVAILABLE" : "FILE_UNAVAILABLE"
      )
    let content: Uint8Array | null
    try {
      content = await this.deps.blobs.get(file.storageReference, {
        maxBytes: file.sizeBytes,
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new FileDeliveryError("FILE_UNAVAILABLE")
    }
    if (!content || !fileContentMatches(content, file))
      throw new FileDeliveryError("FILE_UNAVAILABLE")
    // Membership, resource visibility, deletion and retention can change during storage I/O.
    const current = await this.metadata(actor, target)
    if (
      current.storageReference !== file.storageReference ||
      current.checksum !== file.checksum ||
      current.sizeBytes !== file.sizeBytes
    )
      throw new FileDeliveryError("FILE_UNAVAILABLE")
    await verifyFileGrant(token, actor, target, purpose, this.deps.now?.())
    return { file, content }
  }
}
