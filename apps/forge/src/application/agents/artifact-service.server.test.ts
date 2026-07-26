// @vitest-environment node

import { describe, expect, it } from "vitest"

import type { Actor } from "@/application/actor"
import type {
  AgentArtifactBlobStore,
  AgentArtifactMetadataStore,
  StoredAgentArtifactRecord,
} from "@/application/agents/artifact-store"
import { AgentArtifactService } from "@/application/agents/artifact-service.server"
import { InMemoryAgentStore } from "@/adapters/agents/in-memory-agent-store"
import { InMemoryAgentEventStore } from "@/adapters/agents/in-memory-event-store"

const actor: Actor = {
  userId: "user-1",
  workspaceId: "workspace-1",
  workspaceRole: "member",
  authentication: { kind: "session", sessionId: "session-1" },
  scopes: null,
}

class MemoryMetadata implements AgentArtifactMetadataStore {
  records: Array<StoredAgentArtifactRecord> = []

  create(input: StoredAgentArtifactRecord) {
    this.records.push(input)
    return Promise.resolve(input)
  }

  findByRunChecksumAndName(runId: string, checksum: string, name: string) {
    return Promise.resolve(
      this.records.find(
        (record) =>
          record.runId === runId &&
          record.checksum === checksum &&
          record.name === name
      ) ?? null
    )
  }

  getAuthorized(
    _workspaceId: string,
    _userId: string,
    artifactId: string
  ) {
    return Promise.resolve(
      this.records.find((record) => record.id === artifactId) ?? null
    )
  }

  listExpired(before: Date, limit: number) {
    return Promise.resolve(
      this.records
        .filter(
          (record) =>
            !record.deletedAt &&
            record.retentionExpiresAt !== null &&
            record.retentionExpiresAt <= before
        )
        .slice(0, limit)
    )
  }

  markDeleted(artifactId: string, deletedAt: Date) {
    const record = this.records.find((candidate) => candidate.id === artifactId)
    if (!record || record.deletedAt) return Promise.resolve(null)
    record.deletedAt = deletedAt
    return Promise.resolve(record)
  }
}

class MemoryBlobs implements AgentArtifactBlobStore {
  records = new Map<string, Uint8Array>()

  put(reference: string, content: Uint8Array) {
    this.records.set(reference, content)
    return Promise.resolve()
  }

  get(reference: string) {
    return Promise.resolve(this.records.get(reference) ?? null)
  }

  delete(reference: string) {
    this.records.delete(reference)
    return Promise.resolve()
  }
}

async function fixture(maxBytes = 1024) {
  const agents = new InMemoryAgentStore()
  const events = new InMemoryAgentEventStore()
  const metadata = new MemoryMetadata()
  const blobs = new MemoryBlobs()
  const threadId = "00000000-0000-4000-8000-000000000010"
  const runId = "00000000-0000-4000-8000-000000000020"
  const artifactId = "00000000-0000-4000-8000-000000000030"
  const now = new Date("2026-07-24T00:00:00.000Z")
  await agents.createThread({
    id: threadId,
    workspaceId: actor.workspaceId,
    createdByUserId: actor.userId,
    title: "Artifact test",
    status: "active",
    runtimeKind: "eve",
    runtimeSessionId: null,
    createdAt: now,
  })
  await agents.createRun({
    id: runId,
    threadId,
    initiatedByUserId: actor.userId,
    state: "running",
    executionKind: "forge-native",
    requestedSelection: { mode: "auto" },
    resolvedConnectionId: null,
    resolvedModelId: "gpt-test",
    reasoningEffort: "low",
    routingPolicyVersion: "test",
    routingReason: "test",
    runtimeRunId: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costMicros: 0,
    startedAt: now,
    completedAt: null,
    errorCode: null,
  })
  const service = new AgentArtifactService({
    metadata,
    blobs,
    agents,
    events,
    id: () => artifactId,
    now: () => now,
    maxBytes,
  })
  return { artifactId, blobs, events, metadata, runId, service }
}

describe("AgentArtifactService", () => {
  it("stores bounded content, emits a stable event, and deduplicates replay", async () => {
    const { artifactId, blobs, events, metadata, runId, service } =
      await fixture()
    const input = {
      kind: "report" as const,
      name: "summary.md",
      contentType: "text/markdown",
      encoding: "utf8" as const,
      content: "# Summary",
    }

    const first = await service.create(actor, runId, input)
    const replay = await service.create(actor, runId, input)

    expect(first.id).toBe(artifactId)
    expect(replay.id).toBe(artifactId)
    expect(metadata.records).toHaveLength(1)
    expect(blobs.records).toHaveLength(1)
    await expect(events.listRunEvents(runId)).resolves.toMatchObject([
      {
        sourceEventId: `artifact:${artifactId}`,
        type: "artifact.created",
        payload: { name: "summary.md" },
      },
    ])
  })

  it("rejects content above the configured bound", async () => {
    const { runId, service } = await fixture(3)
    await expect(
      service.create(actor, runId, {
        kind: "file",
        name: "large.txt",
        contentType: "text/plain",
        encoding: "utf8",
        content: "four",
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" })
  })

  it("deletes expired blobs and marks their metadata once", async () => {
    const { artifactId, blobs, metadata, runId, service } = await fixture()
    await service.create(actor, runId, {
      kind: "file",
      name: "expired.txt",
      contentType: "text/plain",
      encoding: "utf8",
      content: "expired",
    })
    const expiredAt = new Date("2026-08-24T00:00:00.000Z")

    await expect(service.sweepExpired(expiredAt)).resolves.toEqual({
      examined: 1,
      deleted: 1,
      failures: [],
    })
    expect(metadata.records[0]).toMatchObject({
      id: artifactId,
      deletedAt: expiredAt,
    })
    expect(blobs.records.size).toBe(0)
    await expect(service.sweepExpired(expiredAt)).resolves.toEqual({
      examined: 0,
      deleted: 0,
      failures: [],
    })
  })
})
