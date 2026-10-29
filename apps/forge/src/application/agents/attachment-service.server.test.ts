// @vitest-environment node

import { describe, expect, it } from "vitest"

import type { Actor } from "@/application/actor"
import type {
  AgentAttachmentMetadataStore,
  StoredAgentAttachmentRecord,
} from "@/application/agents/attachment-store"
import type { AgentArtifactBlobStore } from "@/application/agents/artifact-store"
import { AgentAttachmentService } from "@/application/agents/attachment-service.server"

const actor: Actor = {
  userId: "user-1",
  workspaceId: "workspace-1",
  workspaceRole: "member",
  authentication: { kind: "session", sessionId: "session-1" },
  scopes: null,
}

class MemoryAttachmentMetadata implements AgentAttachmentMetadataStore {
  records: Array<StoredAgentAttachmentRecord> = []

  create(input: StoredAgentAttachmentRecord) {
    this.records.push(input)
    return Promise.resolve(input)
  }

  getAuthorized(
    workspaceId: string,
    userId: string,
    ids: ReadonlyArray<string>
  ) {
    return Promise.resolve(
      this.records.filter(
        (record) =>
          record.workspaceId === workspaceId &&
          record.userId === userId &&
          ids.includes(record.id) &&
          !record.deletedAt
      )
    )
  }

  listExpired(before: Date, limit: number) {
    return Promise.resolve(
      this.records
        .filter((record) => !record.deletedAt && record.expiresAt <= before)
        .slice(0, limit)
    )
  }

  markDeleted(attachmentId: string, deletedAt: Date) {
    const record = this.records.find(
      (candidate) => candidate.id === attachmentId
    )
    if (!record || record.deletedAt) return Promise.resolve(null)
    record.deletedAt = deletedAt
    return Promise.resolve(record)
  }
}

class MemoryAttachmentBlobs implements AgentArtifactBlobStore {
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

function fixture(maxAttachmentBytes = 1024, maxTurnBytes = 2048) {
  const metadata = new MemoryAttachmentMetadata()
  const blobs = new MemoryAttachmentBlobs()
  const now = new Date("2026-07-24T00:00:00.000Z")
  const attachmentId = "00000000-0000-4000-8000-000000000030"
  const service = new AgentAttachmentService({
    metadata,
    blobs,
    id: () => attachmentId,
    now: () => now,
    maxAttachmentBytes,
    maxTurnBytes,
  })
  return { attachmentId, blobs, metadata, now, service }
}

describe("AgentAttachmentService", () => {
  it("rejects tampered attachment bytes before model resolution", async () => {
    const { service, blobs } = fixture()
    const file = await service.upload(actor, {
      name: "a.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("private").toString("base64"),
    })
    const reference = [...blobs.records.keys()][0]
    blobs.records.set(reference, new TextEncoder().encode("changed"))
    await expect(service.resolve(actor, [file.id])).rejects.toMatchObject({
      code: "INVALID_ATTACHMENT",
    })
  })

  it("stores private content and resolves it only for the owning actor", async () => {
    const { attachmentId, blobs, metadata, service } = fixture()
    const contentBase64 = Buffer.from("safe").toString("base64")

    const uploaded = await service.upload(actor, {
      name: "notes.txt",
      contentType: "text/plain",
      contentBase64,
    })

    expect(uploaded).toMatchObject({
      id: attachmentId,
      name: "notes.txt",
      sizeBytes: 4,
    })
    expect(metadata.records[0]?.storageReference).toBe(
      `attachments/${attachmentId}`
    )
    expect(blobs.records.size).toBe(1)
    await expect(service.resolve(actor, [attachmentId])).resolves.toMatchObject(
      [{ id: attachmentId, contentBase64 }]
    )
    await expect(
      service.resolve({ ...actor, userId: "user-2" }, [attachmentId])
    ).rejects.toMatchObject({ code: "ATTACHMENT_NOT_FOUND" })
  })

  it("enforces individual and per-turn byte limits", async () => {
    const { attachmentId, service } = fixture(3, 3)
    await expect(
      service.upload(actor, {
        name: "too-large.txt",
        contentType: "text/plain",
        contentBase64: Buffer.from("four").toString("base64"),
      })
    ).rejects.toMatchObject({ code: "ATTACHMENT_TOO_LARGE" })

    const allowed = fixture(4, 3)
    await allowed.service.upload(actor, {
      name: "four.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("four").toString("base64"),
    })
    await expect(
      allowed.service.resolve(actor, [attachmentId])
    ).rejects.toMatchObject({ code: "ATTACHMENT_TOO_LARGE" })
  })

  it("deletes expired content and tombstones metadata once", async () => {
    const { attachmentId, blobs, metadata, service } = fixture()
    await service.upload(actor, {
      name: "temporary.txt",
      contentType: "text/plain",
      contentBase64: Buffer.from("temporary").toString("base64"),
    })
    const afterExpiry = new Date("2026-07-26T00:00:00.000Z")

    await expect(service.sweepExpired(afterExpiry)).resolves.toEqual({
      examined: 1,
      deleted: 1,
      failures: [],
    })
    expect(blobs.records.size).toBe(0)
    expect(metadata.records[0]).toMatchObject({
      id: attachmentId,
      deletedAt: afterExpiry,
    })
    await expect(service.sweepExpired(afterExpiry)).resolves.toEqual({
      examined: 0,
      deleted: 0,
      failures: [],
    })
  })
})
