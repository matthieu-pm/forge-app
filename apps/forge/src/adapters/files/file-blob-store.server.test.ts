// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { inspectFileStorage } from "../../../../../packages/environment/file-storage"
import { createFileBlobStore } from "./file-blob-store.server"
import { LocalFileBlobStore } from "./local-file-blob-store.server"
import { VercelPrivateFileBlobStore } from "./vercel-private-file-blob-store.server"

vi.mock("@tanstack/react-start/server-only", () => ({}))
const credentials = {
  BLOB_STORE_ID: "store_fixture",
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_fixture_private",
}

describe("shared private file storage selection", () => {
  it.each([
    { FORGE_ENVIRONMENT: "production" },
    { FORGE_ENVIRONMENT: "staging" },
    { NODE_ENV: "production" },
    { VERCEL: "1" },
    { VERCEL_ENV: "preview" },
    { NODE_ENV: "production", FORGE_ENVIRONMENT: "development" },
  ])("never falls back to disk in %j", (env) => {
    expect(() => createFileBlobStore(env)).toThrow("BLOB_STORE_ID")
    expect(createFileBlobStore({ ...env, ...credentials })).toBeInstanceOf(
      VercelPrivateFileBlobStore
    )
    expect(() =>
      createFileBlobStore({
        ...env,
        ...credentials,
        FORGE_AGENT_BLOB_ADAPTER: "local",
      })
    ).toThrow("FORGE_AGENT_BLOB_ADAPTER")
  })
  it("rejects a mismatched bucket/token and unknown adapter without printing values", () => {
    const env = {
      ...credentials,
      FORGE_ENVIRONMENT: "production",
      BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_other_secret",
    }
    expect(() => createFileBlobStore(env)).toThrow("BLOB_READ_WRITE_TOKEN")
    expect(JSON.stringify(inspectFileStorage(env))).not.toContain(
      env.BLOB_READ_WRITE_TOKEN
    )
    expect(() =>
      createFileBlobStore({ FORGE_AGENT_BLOB_ADAPTER: "typo" })
    ).toThrow("FORGE_AGENT_BLOB_ADAPTER")
  })
  it("keeps explicit development disk storage private, immutable and path-safe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-files-"))
    const ref = `files/${randomUUID()}`
    const a = createFileBlobStore({ FORGE_AGENT_ARTIFACT_DIRECTORY: directory })
    expect(a).toBeInstanceOf(LocalFileBlobStore)
    try {
      await a.put(ref, new Uint8Array([1, 2, 3]))
      const b = createFileBlobStore({
        FORGE_AGENT_ARTIFACT_DIRECTORY: directory,
      })
      expect(await b.get(ref)).toEqual(new Uint8Array([1, 2, 3]))
      await expect(b.put(ref, new Uint8Array([4]))).rejects.toThrow()
      for (const bad of [
        "../x",
        "files/../x",
        "https://example.test/file",
        "files/" + "-".repeat(36),
        "files/%2e%2e/x",
      ]) {
        await expect(b.get(bad)).rejects.toThrow("Invalid")
        await expect(b.put(bad, new Uint8Array())).rejects.toThrow("Invalid")
        await expect(b.delete(bad)).rejects.toThrow("Invalid")
      }
      await b.delete(ref)
      expect(await b.get(ref)).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
