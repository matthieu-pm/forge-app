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
import {
  createAgentArtifactInputSchema,
} from "@/application/agents/artifact-contract"
import { mintArtifactAccessToken } from "@/application/agents/artifact-access-token.server"

const DEFAULT_MAX_ARTIFACT_BYTES = 5 * 1024 * 1024

export class AgentArtifactError extends Error {
  constructor(
    readonly code:
      | "ARTIFACT_NOT_FOUND"
      | "ARTIFACT_TOO_LARGE"
      | "INVALID_ARTIFACT_CONTENT",
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

export class AgentArtifactService {
  readonly #id: () => string
  readonly #now: () => Date

  constructor(
    private readonly dependencies: {
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

    await this.dependencies.blobs.put(storageReference, bytes)
    let created: StoredAgentArtifactRecord
    try {
      created = await this.dependencies.metadata.create(record)
    } catch (error) {
      await this.dependencies.blobs.delete(storageReference).catch(() => {})
      throw error
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
    const record = await this.dependencies.metadata.getAuthorized(
      actor.workspaceId,
      actor.userId,
      artifactId
    )
    if (!record || record.deletedAt) {
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
    const record = await this.dependencies.metadata.getAuthorized(
      actor.workspaceId,
      actor.userId,
      artifactId
    )
    if (!record || record.deletedAt) {
      throw new AgentArtifactError(
        "ARTIFACT_NOT_FOUND",
        "The artifact was not found."
      )
    }
    const content = await this.dependencies.blobs.get(record.storageReference)
    if (!content) {
      throw new AgentArtifactError(
        "ARTIFACT_NOT_FOUND",
        "The artifact content is unavailable."
      )
    }
    return { artifact: publicRecord(record), content }
  }

  async sweepExpired(before = this.#now(), limit = 100) {
    const boundedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)))
    const expired = await this.dependencies.metadata.listExpired(
      before,
      boundedLimit
    )
    const failures: Array<{ artifactId: string; message: string }> = []
    let deleted = 0
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
    return { examined: expired.length, deleted, failures }
  }
}
