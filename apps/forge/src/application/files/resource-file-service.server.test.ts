// @vitest-environment node
import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { ResourceFileService } from "./resource-file-service.server"
import type { StoredResourceFile } from "./resource-file-store"
import type { Actor } from "@/application/actor"

vi.mock("@tanstack/react-start/server-only", () => ({}))
const actor: Actor = {
  userId: "user-a",
  workspaceId: "workspace-a",
  workspaceRole: "member",
  authentication: { kind: "session", sessionId: "session" },
  scopes: null,
}
function fixture() {
  const records = new Map<string, StoredResourceFile>()
  const objects = new Map<string, Uint8Array>()
  const metadata = {
    create: vi.fn((record: StoredResourceFile) => {
      records.set(record.id, record)
      return Promise.resolve(record)
    }),
    get: vi.fn((_workspace: string, id: string) =>
      Promise.resolve(records.get(id) ?? null)
    ),
  }
  const blobs = {
    put: vi.fn((ref: string, content: Uint8Array) => {
      objects.set(ref, content)
      return Promise.resolve()
    }),
    get: vi.fn((ref: string) => Promise.resolve(objects.get(ref) ?? null)),
    delete: vi.fn((ref: string) => {
      objects.delete(ref)
      return Promise.resolve()
    }),
  }
  const authorize = vi.fn(async () => {})
  return {
    records,
    objects,
    metadata,
    blobs,
    authorize,
    service: new ResourceFileService({ metadata, blobs, authorize }),
  }
}
const input = {
  name: "evidence.txt",
  contentType: "text/plain",
  content: new TextEncoder().encode("private durable file"),
}
describe("issue/document durable file foundation", () => {
  it.each(["issue", "document"] as const)(
    "persists %s scope/checksum and reads through a replacement service",
    async (kind) => {
      const f = fixture(),
        resource = { kind, id: randomUUID() }
      const file = await f.service.create(actor, resource, input)
      const record = f.records.get(file.id)!
      expect(record).toMatchObject({
        workspaceId: actor.workspaceId,
        createdByUserId: actor.userId,
        resource,
        sizeBytes: input.content.byteLength,
      })
      expect(record.checksum).toMatch(/^[a-f0-9]{64}$/)
      expect(record.storageReference).toMatch(/^files\/[0-9a-f-]{36}$/)
      expect(record.storageReference).not.toContain(resource.id)
      expect(file).not.toHaveProperty("storageReference")
      const b = new ResourceFileService({
        metadata: f.metadata,
        blobs: f.blobs,
        authorize: f.authorize,
      })
      expect((await b.read(actor, file.id)).content).toEqual(input.content)
      expect(f.authorize).toHaveBeenCalledWith(actor, resource, "write")
      expect(f.authorize).toHaveBeenCalledWith(actor, resource, "read")
    }
  )
  it("denies foreign workspace, deleted files and revoked resource access before object reads", async () => {
    const f = fixture(),
      file = await f.service.create(
        actor,
        { kind: "issue", id: randomUUID() },
        input
      )
    await expect(
      f.service.read({ ...actor, workspaceId: "foreign" }, file.id)
    ).rejects.toThrow("not found")
    f.records.get(file.id)!.deletedAt = new Date()
    await expect(f.service.read(actor, file.id)).rejects.toThrow("not found")
    f.records.get(file.id)!.deletedAt = null
    f.authorize.mockRejectedValue(new Error("Denied"))
    await expect(f.service.read(actor, file.id)).rejects.toThrow("Denied")
    await expect(
      f.service.create(actor, { kind: "document", id: randomUUID() }, input)
    ).rejects.toThrow("Denied")
    expect(f.blobs.get).not.toHaveBeenCalled()
    expect(f.blobs.put).toHaveBeenCalledTimes(1)
  })
  it("fails closed on missing, truncated and corrupt content", async () => {
    const f = fixture(),
      file = await f.service.create(
        actor,
        { kind: "document", id: randomUUID() },
        input
      )
    const ref = f.records.get(file.id)!.storageReference
    for (const content of [
      new Uint8Array([1]),
      new Uint8Array(input.content.byteLength),
    ]) {
      f.objects.set(ref, content)
      await expect(f.service.read(actor, file.id)).rejects.toThrow("integrity")
    }
    f.objects.delete(ref)
    await expect(f.service.read(actor, file.id)).rejects.toThrow("unavailable")
  })
  it("compensates failed metadata persistence and never creates metadata for failed uploads", async () => {
    const f = fixture(),
      resource = { kind: "issue" as const, id: randomUUID() }
    f.metadata.create.mockRejectedValueOnce(new Error("metadata failed"))
    await expect(f.service.create(actor, resource, input)).rejects.toThrow(
      "metadata failed"
    )
    expect(f.objects.size).toBe(0)
    f.blobs.put.mockRejectedValueOnce(new Error("storage failed"))
    await expect(f.service.create(actor, resource, input)).rejects.toThrow(
      "storage failed"
    )
    expect(f.metadata.create).toHaveBeenCalledTimes(1)
  })
  it("validates bounded file metadata and resource identities before writing", async () => {
    const f = fixture(),
      resource = { kind: "issue" as const, id: randomUUID() }
    for (const bad of [
      { ...input, content: new Uint8Array() },
      { ...input, name: "../x" },
      { ...input, contentType: "text/plain\r\nX: value" },
      { ...input, content: new Uint8Array(5 * 1024 * 1024 + 1) },
    ]) {
      await expect(f.service.create(actor, resource, bad)).rejects.toThrow()
    }
    expect(f.blobs.put).not.toHaveBeenCalled()
  })
})
