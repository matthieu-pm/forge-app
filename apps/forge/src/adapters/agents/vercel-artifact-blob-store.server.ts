import "@tanstack/react-start/server-only"
import { del, get, put } from "@vercel/blob"
import type { AgentArtifactBlobStore } from "@/application/agents/artifact-store"

/** Private objects are served only through the application's existing authorized download routes. */
export class VercelArtifactBlobStore implements AgentArtifactBlobStore {
  #path(reference: string) {
    if (
      !/^(?:attachments\/[0-9a-f-]{36}|[0-9a-f-]{36}\/[0-9a-f-]{36})$/.test(
        reference
      )
    )
      throw new Error("Invalid artifact storage reference.")
    return `forge/${reference}`
  }
  async put(reference: string, content: Uint8Array) {
    await put(this.#path(reference), Buffer.from(content), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/octet-stream",
    })
  }
  async get(reference: string) {
    const result = await get(this.#path(reference), {
      access: "private",
      useCache: false,
    })
    if (!result) return null
    if (result.statusCode !== 200)
      throw new Error("Unexpected private blob response.")
    return new Uint8Array(await new Response(result.stream).arrayBuffer())
  }
  async delete(reference: string) {
    await del(this.#path(reference))
  }
}
