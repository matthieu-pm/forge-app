import "@tanstack/react-start/server-only"

import { createHash, randomUUID } from "node:crypto"

import type { Actor } from "@/application/actor"
import type {
  AgentAttachmentRecord,
  CreateAgentAttachmentInput,
  ResolvedAgentAttachment,
} from "@/application/agents/attachment-contract"
import type { AgentArtifactBlobStore } from "@/application/agents/artifact-store"
import type {
  AgentAttachmentMetadataStore,
  StoredAgentAttachmentRecord,
} from "@/application/agents/attachment-store"
import { fileContentMatches } from "@/application/files/file-integrity.server"
import { createAgentAttachmentInputSchema } from "@/application/agents/attachment-contract"
import { requireAgentRun } from "@/application/agents/agent-authorization"

const DEFAULT_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_TURN_ATTACHMENT_BYTES = 20 * 1024 * 1024

export class AgentAttachmentError extends Error {
  constructor(
    readonly code:
      "ATTACHMENT_NOT_FOUND" | "ATTACHMENT_TOO_LARGE" | "INVALID_ATTACHMENT",
    message: string
  ) {
    super(message)
    this.name = "AgentAttachmentError"
  }
}

function configuredPositiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name])
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function publicRecord(
  record: StoredAgentAttachmentRecord
): AgentAttachmentRecord {
  const {
    workspaceId: _workspaceId,
    userId: _userId,
    storageReference: _storageReference,
    deletedAt: _deletedAt,
    ...attachment
  } = record
  return attachment
}

function decodeBase64(value: string) {
  const bytes = Buffer.from(value, "base64")
  if (
    bytes.byteLength === 0 ||
    bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")
  ) {
    throw new AgentAttachmentError(
      "INVALID_ATTACHMENT",
      "The attachment content is not valid base64."
    )
  }
  return new Uint8Array(bytes)
}

export class AgentAttachmentService {
  readonly #id: () => string
  readonly #now: () => Date

  constructor(
    private readonly dependencies: {
      authorizeActor?: (actor: Actor) => Promise<Actor>
      metadata: AgentAttachmentMetadataStore
      blobs: AgentArtifactBlobStore
      id?: () => string
      now?: () => Date
      maxAttachmentBytes?: number
      maxTurnBytes?: number
      authorizeUpload?: (actor: Actor, contentType: string) => Promise<void>
    }
  ) {
    this.#id = dependencies.id ?? randomUUID
    this.#now = dependencies.now ?? (() => new Date())
  }

  async upload(actor: Actor, rawInput: CreateAgentAttachmentInput) {
    actor = (await this.dependencies.authorizeActor?.(actor)) ?? actor
    requireAgentRun(actor)
    const input = createAgentAttachmentInputSchema.parse(rawInput)
    await this.dependencies.authorizeUpload?.(actor, input.contentType)
    const content = decodeBase64(input.contentBase64)
    const maxBytes =
      this.dependencies.maxAttachmentBytes ??
      configuredPositiveInteger(
        "FORGE_AGENT_MAX_ATTACHMENT_BYTES",
        DEFAULT_MAX_ATTACHMENT_BYTES
      )
    if (content.byteLength > maxBytes) {
      throw new AgentAttachmentError(
        "ATTACHMENT_TOO_LARGE",
        `Attachments cannot exceed ${maxBytes} bytes.`
      )
    }
    const id = this.#id()
    const now = this.#now()
    const retentionHours = configuredPositiveInteger(
      "FORGE_AGENT_ATTACHMENT_RETENTION_HOURS",
      24
    )
    const record: StoredAgentAttachmentRecord = {
      id,
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      name: input.name,
      contentType: input.contentType,
      sizeBytes: content.byteLength,
      checksum: createHash("sha256").update(content).digest("hex"),
      storageReference: `attachments/${id}`,
      expiresAt: new Date(now.getTime() + retentionHours * 60 * 60_000),
      deletedAt: null,
      createdAt: now,
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

  async resolve(
    actor: Actor,
    attachmentIds: ReadonlyArray<string>
  ): Promise<Array<ResolvedAgentAttachment>> {
    actor = (await this.dependencies.authorizeActor?.(actor)) ?? actor
    requireAgentRun(actor)
    const ids = [...new Set(attachmentIds)]
    if (ids.length !== attachmentIds.length || ids.length > 20) {
      throw new AgentAttachmentError(
        "INVALID_ATTACHMENT",
        "A turn can contain at most 20 unique attachments."
      )
    }
    if (ids.length === 0) return []
    const records = await this.dependencies.metadata.getAuthorized(
      actor.workspaceId,
      actor.userId,
      ids
    )
    const recordsById = new Map(records.map((record) => [record.id, record]))
    const now = this.#now()
    const ordered = ids.map((id) => recordsById.get(id))
    if (
      ordered.some(
        (record) =>
          !record || record.deletedAt !== null || record.expiresAt <= now
      )
    ) {
      throw new AgentAttachmentError(
        "ATTACHMENT_NOT_FOUND",
        "One or more attachments are unavailable or expired."
      )
    }
    const maxTurnBytes =
      this.dependencies.maxTurnBytes ??
      configuredPositiveInteger(
        "FORGE_AGENT_MAX_TURN_ATTACHMENT_BYTES",
        DEFAULT_MAX_TURN_ATTACHMENT_BYTES
      )
    const size = ordered.reduce(
      (total, record) => total + (record?.sizeBytes ?? 0),
      0
    )
    if (size > maxTurnBytes) {
      throw new AgentAttachmentError(
        "ATTACHMENT_TOO_LARGE",
        `Turn attachments cannot exceed ${maxTurnBytes} bytes in total.`
      )
    }
    return Promise.all(
      ordered.map(async (record) => {
        if (!record) {
          throw new AgentAttachmentError(
            "ATTACHMENT_NOT_FOUND",
            "The attachment is unavailable."
          )
        }
        const content = await this.dependencies.blobs.get(
          record.storageReference
        )
        if (!content) {
          throw new AgentAttachmentError(
            "ATTACHMENT_NOT_FOUND",
            "The attachment content is unavailable."
          )
        }
        if (!fileContentMatches(content, record))
          throw new AgentAttachmentError(
            "INVALID_ATTACHMENT",
            "The attachment content failed its integrity check."
          )
        return {
          ...publicRecord(record),
          contentBase64: Buffer.from(content).toString("base64"),
        }
      })
    )
  }

  async sweepExpired(before = this.#now(), limit = 100) {
    const expired = await this.dependencies.metadata.listExpired(
      before,
      Math.max(1, Math.min(1_000, Math.floor(limit)))
    )
    let deleted = 0
    const failures: Array<{ attachmentId: string; message: string }> = []
    for (const attachment of expired) {
      try {
        await this.dependencies.blobs.delete(attachment.storageReference)
        if (
          await this.dependencies.metadata.markDeleted(attachment.id, before)
        ) {
          deleted += 1
        }
      } catch (error) {
        failures.push({
          attachmentId: attachment.id,
          message:
            error instanceof Error
              ? error.message
              : "Attachment retention failed.",
        })
      }
    }
    return { examined: expired.length, deleted, failures }
  }
}
