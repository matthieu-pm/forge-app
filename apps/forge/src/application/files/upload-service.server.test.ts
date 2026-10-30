// @vitest-environment node
import { createHash, randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { UploadService } from "./upload-service.server"
import { UploadError } from "./upload-contract"
import { createUploadHttpHandler } from "./upload-http-handler.server"
import { inspectUploadType } from "./upload-type.server"
import type { Actor } from "../actor"
import type {
  DirectUploadTransport,
  UploadIntent,
  UploadStore,
} from "./upload-store"

vi.mock("@tanstack/react-start/server-only", () => ({}))
const actor: Actor = {
  userId: "user",
  workspaceId: "workspace",
  workspaceRole: "member",
  authentication: { kind: "session", sessionId: "session" },
  scopes: null,
}
function fixture(bytes = new TextEncoder().encode("file")) {
  const intent: UploadIntent = {
    id: randomUUID(),
    commandKey: randomUUID(),
    target: { kind: "agent" },
    name: "test.txt",
    contentType: "text/plain",
    sizeBytes: bytes.length,
    checksum: createHash("sha256").update(bytes).digest("hex"),
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    storageReference: `files/${randomUUID()}`,
    state: "pending",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
    tokenExpiresAt: new Date(Date.now() + 600000),
    attempts: [],
    result: null,
    rejectionReason: null,
    cleanedAt: null,
  }
  const store: UploadStore = {
    create: vi.fn(async () => intent),
    prepare: vi.fn(async () => intent),
    publish: vi.fn(async (_actor, _id, verified) => ({
      id: intent.id,
      name: intent.name,
      ...verified,
      createdAt: intent.createdAt.toISOString(),
      expiresAt: intent.expiresAt.toISOString(),
    })),
    reject: vi.fn(async () => {}),
    cleanupCandidates: vi.fn(async () => [intent]),
    markCleaned: vi.fn(async () => {}),
  }
  const cancelled = vi.fn()
  const transport: DirectUploadTransport = {
    grant: vi.fn(async () => ({
      adapter: "local" as const,
      url: "/bytes",
      validUntil: Date.now() + 600000,
      maximumSizeInBytes: bytes.length,
    })),
    read: vi.fn(
      async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes)
            controller.close()
          },
          cancel: cancelled,
        })
    ),
    delete: vi.fn(async () => {}),
  }
  const service = new UploadService(store, transport)
  return { intent, store, transport, service, cancelled }
}
describe("validated direct uploads", () => {
  it("hashes a permitted 5 MiB stream and publishes verified bytes without embedding bytes in the result", async () => {
    const f = fixture(new Uint8Array(5 * 1024 * 1024).fill(65))
    const ready = await f.service.finalize(actor, f.intent.id)
    expect(ready).toMatchObject({
      sizeBytes: 5 * 1024 * 1024,
      checksum: f.intent.checksum,
    })
    expect(JSON.stringify(ready).length).toBeLessThan(1000)
    expect(f.store.publish).toHaveBeenCalledOnce()
  })
  it.each(["size", "checksum"])(
    "rejects a forged %s and retains cleanup inventory",
    async (kind) => {
      const f = fixture()
      if (kind === "size") f.intent.sizeBytes = 1
      else f.intent.checksum = "0".repeat(64)
      await expect(
        f.service.finalize(actor, f.intent.id)
      ).rejects.toMatchObject({ code: "INVALID_UPLOAD" })
      expect(f.store.reject).toHaveBeenCalledOnce()
      expect(f.store.publish).not.toHaveBeenCalled()
    }
  )
  it("validates structured JSON from bytes rather than its client MIME", async () => {
    const valid = fixture(new TextEncoder().encode('{"message":"café"}'))
    valid.intent.contentType = "application/json"
    expect(await valid.service.finalize(actor, valid.intent.id)).toMatchObject({
      contentType: "application/json",
    })
    const invalid = fixture(new TextEncoder().encode("not json"))
    invalid.intent.contentType = "application/json"
    await expect(
      invalid.service.finalize(actor, invalid.intent.id)
    ).rejects.toMatchObject({ code: "INVALID_UPLOAD" })
    expect(invalid.store.publish).not.toHaveBeenCalled()
  })
  it("does not publish when final transactional authorization fails", async () => {
    const f = fixture()
    vi.mocked(f.store.publish).mockRejectedValue(
      new UploadError("INVALID_UPLOAD", "Plan changed.")
    )
    await expect(f.service.finalize(actor, f.intent.id)).rejects.toThrow(
      "Plan changed"
    )
    expect(f.store.reject).toHaveBeenCalledOnce()
  })
  it("releases the reservation when current policy refuses a renewed upload token", async () => {
    const f = fixture()
    vi.mocked(f.store.prepare).mockRejectedValue(
      new UploadError("INVALID_UPLOAD", "Plan changed.")
    )
    await expect(f.service.token(actor, f.intent.id)).rejects.toThrow(
      "Plan changed"
    )
    expect(f.store.reject).toHaveBeenCalledOnce()
    expect(f.transport.grant).not.toHaveBeenCalled()
  })
  it("keeps a missing object or provider outage retryable", async () => {
    const f = fixture()
    vi.mocked(f.transport.read).mockResolvedValue(null)
    await expect(f.service.finalize(actor, f.intent.id)).rejects.toMatchObject({
      code: "UPLOAD_UNAVAILABLE",
    })
    vi.mocked(f.transport.read).mockRejectedValue(new Error("Provider offline"))
    await expect(f.service.finalize(actor, f.intent.id)).rejects.toThrow(
      "Provider offline"
    )
    expect(f.store.reject).not.toHaveBeenCalled()
  })
  it("retains failed deletion inventory and retries the same opaque key", async () => {
    const f = fixture()
    vi.mocked(f.transport.delete).mockRejectedValueOnce(new Error("Offline"))
    expect(await f.service.sweep()).toMatchObject({
      deleted: 0,
      failures: [f.intent.id],
    })
    expect(f.store.markCleaned).not.toHaveBeenCalled()
    expect(await f.service.sweep()).toMatchObject({ deleted: 1, failures: [] })
    expect(f.transport.delete).toHaveBeenNthCalledWith(
      2,
      f.intent.storageReference
    )
  })
  it("rejects oversized chunked metadata without trusting Content-Length", async () => {
    const f = fixture(),
      getActor = vi.fn(async () => actor),
      handler = createUploadHttpHandler({ getActor, service: f.service })
    const request = new Request("https://forge.test/api/files/uploads/", {
      method: "POST",
      headers: { origin: "https://forge.test" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("x".repeat(9000)))
          c.close()
        },
      }),
      duplex: "half",
    } as RequestInit)
    expect((await handler(request)).status).toBe(400)
    expect(f.store.create).not.toHaveBeenCalled()
  })
  it("denies cross-origin mutations before reading bodies or obtaining storage tokens", async () => {
    const f = fixture(),
      getActor = vi.fn(async () => actor),
      handler = createUploadHttpHandler({ getActor, service: f.service })
    expect(
      (
        await handler(
          new Request(
            `https://forge.test/api/files/uploads/${f.intent.id}/token`,
            { method: "POST", headers: { origin: "https://evil.test" } }
          )
        )
      ).status
    ).toBe(403)
    expect(getActor).not.toHaveBeenCalled()
    expect(f.transport.grant).not.toHaveBeenCalled()
  })
  it("does not accept storage URLs, forged plans or fields at finalization", async () => {
    const f = fixture(),
      handler = createUploadHttpHandler({
        getActor: async () => actor,
        service: f.service,
      })
    const res = await handler(
      new Request(
        `https://forge.test/api/files/uploads/${f.intent.id}/finalize`,
        {
          method: "POST",
          headers: { origin: "https://forge.test" },
          body: JSON.stringify({
            url: "https://evil.test",
            plan: "enterprise",
          }),
        }
      )
    )
    expect(res.status).toBe(400)
    expect(f.store.prepare).not.toHaveBeenCalled()
  })
  it("classifies signatures and text, refuses known MIME spoofing and gives unknown bytes a generic type", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\nhello")
    expect(await inspectUploadType(pdf, true, "application/pdf")).toBe(
      "application/pdf"
    )
    await expect(
      inspectUploadType(pdf, true, "image/png")
    ).rejects.toMatchObject({ code: "INVALID_UPLOAD" })
    expect(
      await inspectUploadType(
        new Uint8Array([0, 255, 0, 1]),
        false,
        "image/png"
      )
    ).toBe("application/octet-stream")
  })
})
