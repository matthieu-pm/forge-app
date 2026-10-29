// @vitest-environment node
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { STAGING } from "../../../../../packages/environment/staging-environment"
import { VercelArtifactBlobStore } from "./vercel-artifact-blob-store.server"

vi.mock("@tanstack/react-start/server-only", () => ({}))

const token = process.env.FORGE_STAGING_BLOB_TEST_TOKEN
describe.skipIf(!token)("actual isolated private Blob store", () => {
  afterEach(() => vi.unstubAllEnvs())
  it("roundtrips bytes, denies anonymous access and removes only its exact object", async () => {
    // Token identity is checked before invoking an SDK operation. Production tokens cannot be used here.
    expect(token!.split("_")[3]).toBe(STAGING.blobStoreId.replace("store_", ""))
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", token)
    vi.stubEnv("BLOB_STORE_ID", STAGING.blobStoreId)
    vi.stubEnv("VERCEL_OIDC_TOKEN", "")
    const store = new VercelArtifactBlobStore(),
      reference = `${randomUUID()}/${randomUUID()}`
    const bytes = new TextEncoder().encode(
      "FOR-27 synthetic private storage fixture"
    )
    let written = false
    try {
      await store.put(reference, bytes)
      written = true
      expect(await store.get(reference)).toEqual(bytes)
      await expect(store.put(reference, bytes)).rejects.toThrow()
      const anonymous = await fetch(
        `https://${STAGING.blobStoreId.replace("store_", "").toLowerCase()}.private.blob.vercel-storage.com/forge/${reference}`
      )
      expect([401, 403, 404]).toContain(anonymous.status)
      await store.delete(reference)
      expect(await store.get(reference)).toBeNull()
    } finally {
      if (written) await store.delete(reference)
    }
  }, 60_000)
})
