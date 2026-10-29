// @vitest-environment node
import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { checkPrivateStorage } from "./storage-check.server"

vi.mock("@tanstack/react-start/server-only", () => ({}))
function fixture() {
  const records = new Map<string, Uint8Array>()
  return {
    get: vi.fn((key: string) => Promise.resolve(records.get(key) ?? null)),
    put: vi.fn((key: string, bytes: Uint8Array) => {
      if (records.has(key)) throw Error("immutable")
      records.set(key, bytes)
      return Promise.resolve()
    }),
    delete: vi.fn((key: string) => {
      records.delete(key)
      return Promise.resolve()
    }),
  }
}
describe("bounded production storage verification", () => {
  it("roundtrips one exact synthetic key across replacement store clients and deletes it", async () => {
    const blobs = fixture(),
      objectId = randomUUID()
    const a = await checkPrivateStorage({ blobs, objectId, action: "write" })
    const b = await checkPrivateStorage({
      blobs: { ...blobs },
      objectId,
      action: "read",
    })
    expect(b.checksum).toBe(a.checksum)
    await expect(
      checkPrivateStorage({ blobs, objectId, action: "write" })
    ).rejects.toThrow("immutable")
    expect(
      await checkPrivateStorage({ blobs, objectId, action: "delete" })
    ).toMatchObject({ verified: true, deleted: true })
    expect(blobs.put.mock.calls[0][0]).toBe(`files/${objectId}`)
  })
  it.each([undefined, "../customer-file", "https://example.test/file"])(
    "rejects configured key %s before touching storage",
    async (objectId) => {
      const blobs = fixture()
      await expect(
        checkPrivateStorage({ blobs, objectId, action: "delete" })
      ).rejects.toThrow()
      expect(blobs.delete).not.toHaveBeenCalled()
      expect(blobs.get).not.toHaveBeenCalled()
    }
  )
  it("rejects unknown actions and missing/corrupt bytes", async () => {
    const blobs = fixture(),
      objectId = randomUUID()
    await expect(
      checkPrivateStorage({ blobs, objectId, action: "copy" })
    ).rejects.toThrow()
    await expect(
      checkPrivateStorage({ blobs, objectId, action: "read" })
    ).rejects.toThrow("failed")
    blobs.get.mockResolvedValue(new Uint8Array([1, 2]))
    await expect(
      checkPrivateStorage({ blobs, objectId, action: "read" })
    ).rejects.toThrow("failed")
  })
})
