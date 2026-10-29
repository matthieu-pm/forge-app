import "@tanstack/react-start/server-only"
import { del, get, put } from "@vercel/blob"
import { inspectFileStorage } from "../../../../../packages/environment/file-storage"
import type { FileBlobStore } from "@/application/files/blob-store"
import { assertFileReference } from "@/application/files/blob-store"

/** Credentials are captured per instance so a process cannot drift to another bucket. */
export class VercelPrivateFileBlobStore implements FileBlobStore {
  readonly #token: string
  constructor(env: Record<string, string | undefined> = process.env) {
    const config = inspectFileStorage({
      ...env,
      FORGE_AGENT_BLOB_ADAPTER: "vercel-private",
    })
    if (config.issues.length)
      throw new Error(
        `Private file storage configuration is invalid: ${config.issues.map((issue) => issue.variable).join(", ")}. Values are redacted.`
      )
    this.#token = env.BLOB_READ_WRITE_TOKEN!
  }
  #path(reference: string) {
    assertFileReference(reference)
    return `forge/${reference}`
  }
  async put(reference: string, content: Uint8Array) {
    await put(this.#path(reference), Buffer.from(content), {
      token: this.#token,
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/octet-stream",
    })
  }
  async get(reference: string) {
    const result = await get(this.#path(reference), {
      token: this.#token,
      access: "private",
      useCache: false,
    })
    if (!result) return null
    if (result.statusCode !== 200)
      throw new Error("Unexpected private blob response.")
    return new Uint8Array(await new Response(result.stream).arrayBuffer())
  }
  async delete(reference: string) {
    await del(this.#path(reference), { token: this.#token })
  }
}
