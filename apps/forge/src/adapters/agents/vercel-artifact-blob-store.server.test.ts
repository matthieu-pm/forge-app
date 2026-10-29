// @vitest-environment node
import { randomUUID } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { VercelArtifactBlobStore } from "./vercel-artifact-blob-store.server"

const credentials = {
  BLOB_STORE_ID: "store_fixture",
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_fixture_private",
}
const mocks = vi.hoisted(() => ({ put: vi.fn(), get: vi.fn(), del: vi.fn() }))
vi.mock("@tanstack/react-start/server-only", () => ({}))
vi.mock("@vercel/blob", () => mocks)

describe("private artifact blobs", () => {
  beforeEach(() => vi.clearAllMocks())
  it("uses private immutable writes and authenticated uncached reads", async () => {
    const store = new VercelArtifactBlobStore(credentials),
      reference = `${randomUUID()}/${randomUUID()}`
    await store.put(reference, new Uint8Array([1, 2]))
    expect(mocks.put).toHaveBeenCalledWith(
      `forge/${reference}`,
      Buffer.from([1, 2]),
      {
        token: credentials.BLOB_READ_WRITE_TOKEN,
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: "application/octet-stream",
      }
    )
    mocks.get.mockResolvedValue({
      statusCode: 200,
      stream: new Response(new Uint8Array([1, 2])).body,
    })
    expect(await store.get(reference)).toEqual(new Uint8Array([1, 2]))
    expect(mocks.get).toHaveBeenCalledWith(`forge/${reference}`, {
      token: credentials.BLOB_READ_WRITE_TOKEN,
      access: "private",
      useCache: false,
    })
    mocks.get.mockResolvedValue(null)
    expect(await store.get(reference)).toBeNull()
    await store.delete(reference)
    expect(mocks.del).toHaveBeenCalledWith(`forge/${reference}`, {
      token: credentials.BLOB_READ_WRITE_TOKEN,
    })
  })
  it.each([
    "../production",
    "https://production.example/file",
    "attachments/../x",
    "/absolute",
  ])("rejects reference %s before store access", async (reference) => {
    const store = new VercelArtifactBlobStore(credentials)
    await expect(store.put(reference, new Uint8Array())).rejects.toThrow(
      "Invalid"
    )
    await expect(store.get(reference)).rejects.toThrow("Invalid")
    await expect(store.delete(reference)).rejects.toThrow("Invalid")
    expect(mocks.put).not.toHaveBeenCalled()
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.del).not.toHaveBeenCalled()
  })
})
