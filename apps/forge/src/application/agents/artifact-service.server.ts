import "@tanstack/react-start/server-only"

import { createHash, randomUUID } from "node:crypto"

import type { Actor } from "@/application/actor"
import type { AgentStore } from "@/application/agents/agent-store"
import type {
  AgentArtifactRecord,
  CreateAgentArtifactInput,
} from "@/application/agents/artifact-contract"
import type {
  AgentArtifactBlobStore,
  AgentArtifactMetadataStore,
  StoredAgentArtifactRecord,
} from "@/application/agents/artifact-store"
import type { AgentEventStore } from "@/application/agents/event-store"
import { fileContentMatches } from "@/application/files/file-integrity.server"
import { createAgentArtifactInputSchema } from "@/application/agents/artifact-contract"
import { mintArtifactAccessToken } from "@/application/agents/artifact-access-token.server"
import {
  requireAgentRead,
  requireAgentRun,
} from "@/application/agents/agent-authorization"

const DEFAULT_MAX_ARTIFACT_BYTES = 5 * 1024 * 1024

export class AgentArtifactError extends Error {
  constructor(
    readonly code:
      "ARTIFACT_NOT_FOUND" | "ARTIFACT_TOO_LARGE" | "INVALID_ARTIFACT_CONTENT",
    message: string
  ) {
    super(message)
    this.name = "AgentArtifactError"
  }
}

function configuredMaxBytes() {
  const parsed = Number(process.env.FORGE_AGENT_MAX_ARTIFACT_BYTES)
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_ARTIFACT_BYTES
}

function configuredRetentionMs() {
  const days = Number(process.env.FORGE_AGENT_ARTIFACT_RETENTION_DAYS)
  const boundedDays =
    Number.isSafeInteger(days) && days > 0 && days <= 3_650 ? days : 30
  return boundedDays * 24 * 60 * 60_000
}

function decodeContent(input: CreateAgentArtifactInput) {
  try {
    return input.encoding === "base64"
      ? new Uint8Array(Buffer.from(input.content, "base64"))
      : new TextEncoder().encode(input.content)
  } catch {
    throw new AgentArtifactError(
      "INVALID_ARTIFACT_CONTENT",
      "The artifact content could not be decoded."
    )
  }
}

function publicRecord(record: StoredAgentArtifactRecord): AgentArtifactRecord {
  const { storageReference: _storageReference, ...artifact } = record
  return artifact
}

export type AgentArtifactPublication = {
  reserve: (actor: Actor, record: StoredAgentArtifactRecord) => Promise<void>
  publish: (
    actor: Actor,
    record: StoredAgentArtifactRecord
  ) => Promise<StoredAgentArtifactRecord>
  recoverPublished: (
    actor: Actor,
    record: StoredAgentArtifactRecord
  ) => Promise<StoredAgentArtifactRecord | null>
  abandon: (
    actor: Actor,
    record: Pick<StoredAgentArtifactRecord, "id" | "runId" | "storageReference">
  ) => Promise<void>
  sweepExpired: (
    before: Date,
    limit: number,
    blobs: Pick<AgentArtifactBlobStore, "delete">
  ) => Promise<{
    examined: number
    deleted: number
    failures: Array<{ artifactId: string; message: string }>
  }>
}

export class AgentArtifactService {
  readonly #id: () => string
  readonly #now: () => Date

  constructor(
    private readonly dependencies: {
      authorizeActor?: (actor: Actor) => Promise<Actor>
      publication?: AgentArtifactPublication
      metadata: AgentArtifactMetadataStore
      blobs: AgentArtifactBlobStore
      agents: AgentStore
      events: AgentEventStore
      id?: () => string
      now?: () => Date
      maxBytes?: number
    }
  ) {
    this.#id = dependencies.id ?? randomUUID
    this.#now = dependencies.now ?? (() => new Date())
  }

  async create(
    actor: Actor,
    runId: string,
    rawInput: CreateAgentArtifactInput
  ): Promise<AgentArtifactRecord> {
    actor = (await this.dependencies.authorizeActor?.(actor)) ?? actor
    requireAgentRun(actor)
    const input = createAgentArtifactInputSchema.parse(rawInput)
    const run = await this.dependencies.agents.getRun(actor.workspaceId, runId)
    if (!run || run.initiatedByUserId !== actor.userId) {
      throw new AgentArtifactError(
        "ARTIFACT_NOT_FOUND",
        "The agent run was not found."
      )
    }
    if (
      actor.authentication.kind === "agent" &&
      actor.authentication.runId !== runId
    ) {
      throw new AgentArtifactError(
        "ARTIFACT_NOT_FOUND",
        "The agent run was not found."
      )
    }

    const bytes = decodeContent(input)
    const maxBytes = this.dependencies.maxBytes ?? configuredMaxBytes()
    if (bytes.byteLength > maxBytes) {
      throw new AgentArtifactError(
        "ARTIFACT_TOO_LARGE",
        `Artifacts cannot exceed ${maxBytes} bytes.`
      )
    }
    const checksum = createHash("sha256").update(bytes).digest("hex")
    const existing = await this.dependencies.metadata.findByRunChecksumAndName(
      runId,
      checksum,
      input.name
    )
    if (existing && !existing.deletedAt) return publicRecord(existing)

    const id = this.#id()
    const now = this.#now()
    const storageReference = `${runId}/${id}`
    const record: StoredAgentArtifactRecord = {
      id,
      runId,
      kind: input.kind,
      name: input.name,
      contentType: input.contentType,
      sizeBytes: bytes.byteLength,
      storageReference,
      checksum,
      retentionExpiresAt: new Date(now.getTime() + configuredRetentionMs()),
      deletedAt: null,
      createdAt: now,
    }

    let created: StoredAgentArtifactRecord
    if (actor.loopScope) {
      const publication = this.dependencies.publication
      if (!publication)
        throw new AgentArtifactError(
          "ARTIFACT_NOT_FOUND",
          "Loop artifact publication is unavailable."
        )
      try {
        // Commit byte ownership before network I/O. A crashed upload leaves a
        // durable cleanup reference rather than an unowned private object.
        await publication.reserve(actor, record)
        await this.dependencies.blobs.put(storageReference, bytes, {
          signal: AbortSignal.timeout(60_000),
        })
        created = await publication.publish(actor, record)
      } catch (error) {
        let recovered: StoredAgentArtifactRecord | null
        try {
          recovered = await publication.recoverPublished(actor, record)
        } catch {
          throw error
        }
        if (recovered) {
          // A lost commit response is confirmed without deleting published bytes.
          await this.dependencies.authorizeActor?.(actor)
          created = recovered
        } else {
          try {
            await this.dependencies.blobs.delete(storageReference)
            await publication.abandon(actor, record)
          } catch {
            /* Keep the durable reference until byte deletion succeeds. */
          }
          throw error
        }
      }
    } else {
      await this.dependencies.blobs.put(storageReference, bytes)
      try {
        created = await this.dependencies.metadata.create(record)
      } catch (error) {
        await this.dependencies.blobs.delete(storageReference).catch(() => {})
        throw error
      }
    }
    await this.dependencies.events.append({
      threadId: run.threadId,
      runId,
      sourceEventId: `artifact:${created.id}`,
      occurredAt: now.toISOString(),
      source: "forge",
      type: "artifact.created",
      schemaVersion: 1,
      payload: publicRecord(created),
    })
    return publicRecord(created)
  }

  async getMetadata(actor: Actor, artifactId: string) {
    actor = (await this.dependencies.authorizeActor?.(actor)) ?? actor
    requireAgentRead(actor)
    const record = await this.dependencies.metadata.getAuthorized(
      actor.workspaceId,
      actor.userId,
      artifactId,
      actor
    )
    if (
      !record ||
      record.deletedAt ||
      (record.retentionExpiresAt && record.retentionExpiresAt <= this.#now())
    ) {
      throw new AgentArtifactError(
        "ARTIFACT_NOT_FOUND",
        "The artifact was not found."
      )
    }
    return publicRecord(record)
  }

  async createDownload(actor: Actor, artifactId: string) {
    const artifact = await this.getMetadata(actor, artifactId)
    const token = await mintArtifactAccessToken(actor, artifactId)
    return {
      artifact,
      downloadUrl: `/api/agent/artifacts/${encodeURIComponent(artifactId)}/content?token=${encodeURIComponent(token)}`,
      expiresInSeconds: 300,
    }
  }

  async read(actor: Actor, artifactId: string) {
    actor = (await this.dependencies.authorizeActor?.(actor)) ?? actor
    requireAgentRead(actor)
    const record = await this.dependencies.metadata.getAuthorized(
      actor.workspaceId,
      actor.userId,
      artifactId,
      actor
    )
    if (
      !record ||
      record.deletedAt ||
      (record.retentionExpiresAt && record.retentionExpiresAt <= this.#now())
    ) {
      throw new AgentArtifactError(
        "ARTIFACT_NOT_FOUND",
        "The artifact was not found."
      )
    }
    if (record.sizeBytes > 100_000_000)
      throw new AgentArtifactError(
        "ARTIFACT_TOO_LARGE",
        "The artifact exceeds the delivery limit."
      )
    const content = await this.dependencies.blobs.get(record.storageReference, {
      maxBytes: record.sizeBytes,
      signal: AbortSignal.timeout(30_000),
    })
    if (!content) {
      throw new AgentArtifactError(
        "ARTIFACT_NOT_FOUND",
        "The artifact content is unavailable."
      )
    }
    if (!fileContentMatches(content, record))
      throw new AgentArtifactError(
        "INVALID_ARTIFACT_CONTENT",
        "The artifact content failed its integrity check."
      )
    await this.getMetadata(actor, artifactId)
    return { artifact: publicRecord(record), content }
  }

  async sweepExpired(before = this.#now(), limit = 100) {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)))
    const expired = await this.dependencies.metadata.listExpired(
      before,
      boundedLimit
    )
    const reservations = (await this.dependencies.publication?.sweepExpired(
      before,
      boundedLimit,
      this.dependencies.blobs
    )) ?? { examined: 0, deleted: 0, failures: [] }
    const failures: Array<{ artifactId: string; message: string }> = [
      ...reservations.failures,
    ]
    let deleted = reservations.deleted
    for (const artifact of expired) {
      try {
        await this.dependencies.blobs.delete(artifact.storageReference)
        const marked = await this.dependencies.metadata.markDeleted(
          artifact.id,
          before
        )
        if (marked) deleted += 1
      } catch (error) {
        failures.push({
          artifactId: artifact.id,
          message:
            error instanceof Error
              ? error.message
              : "Artifact retention failed.",
        })
      }
    }
    return {
      examined: expired.length + reservations.examined,
      deleted,
      failures,
    }
  }
}
