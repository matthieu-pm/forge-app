// @vitest-environment node
import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { migrateLocalFile } from "./migrate-local-file"

function fixture() {
  const bytes = new Uint8Array([0, 1, 255]),
    reference = "attachments/00000000-0000-4000-8000-000000000001"
  let stored: Uint8Array | null = null
  const source = {
    get: vi.fn(() => Promise.resolve(bytes)),
    put: vi.fn(),
    delete: vi.fn(),
  }
  const destination = {
    get: vi.fn(() => Promise.resolve(stored)),
    put: vi.fn((_ref: string, content: Uint8Array) => {
      stored = content
      return Promise.resolve()
    }),
    delete: vi.fn(),
  }
  return {
    reference,
    checksum: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
    source,
    destination,
    apply: true,
  }
}
describe("local file durability migration", () => {
  it("copies with verified readback; retries need no local copy and preserve source", async () => {
    const input = fixture()
    expect(await migrateLocalFile(input)).toBe("copied")
    input.source.get.mockResolvedValue(new Uint8Array())
    expect(await migrateLocalFile(input)).toBe("already-durable")
    expect(input.source.delete).not.toHaveBeenCalled()
    expect(input.destination.put).toHaveBeenCalledTimes(1)
  })
  it("check mode reports incomplete durability without writing", async () => {
    const input = fixture()
    expect(await migrateLocalFile({ ...input, apply: false })).toBe(
      "requires-copy"
    )
    expect(input.destination.put).not.toHaveBeenCalled()
  })
  it("rejects corrupt source/destination without overwriting", async () => {
    const input = fixture()
    input.source.get.mockResolvedValue(new Uint8Array([0]))
    await expect(migrateLocalFile(input)).rejects.toThrow("Source")
    expect(input.destination.put).not.toHaveBeenCalled()
    input.destination.get.mockResolvedValue(new Uint8Array([2]))
    await expect(migrateLocalFile(input)).rejects.toThrow("Destination")
    expect(input.destination.put).not.toHaveBeenCalled()
  })
  it("does not report success when readback is missing/corrupt", async () => {
    const input = fixture()
    input.destination.put.mockResolvedValueOnce(undefined)
    await expect(migrateLocalFile(input)).rejects.toThrow("read-back")
  })
})
