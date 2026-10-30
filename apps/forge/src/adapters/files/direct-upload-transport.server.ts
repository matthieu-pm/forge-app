import "@tanstack/react-start/server-only"
import { createReadStream } from "node:fs"
import { access } from "node:fs/promises"
import { resolve } from "node:path"
import { Readable } from "node:stream"
import { del, get } from "@vercel/blob"
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client"
import { inspectFileStorage } from "../../../../../packages/environment/file-storage"
import { LocalFileBlobStore } from "./local-file-blob-store.server"
import type {
  DirectUploadTransport,
  UploadIntent,
} from "@/application/files/upload-store"
import { assertFileReference } from "@/application/files/blob-store"

export function createDirectUploadTransport(
  env: Record<string, string | undefined> = process.env
): DirectUploadTransport {
  const config = inspectFileStorage(env)
  if (config.issues.length)
    throw new Error(
      "Invalid upload storage configuration. Values are redacted."
    )
  if (config.adapter === "local") {
    const root = resolve(
      env.FORGE_AGENT_ARTIFACT_DIRECTORY ?? ".forge/agent-artifacts"
    )
    const blobs = new LocalFileBlobStore(root)
    return {
      async grant(intent) {
        return {
          adapter: "local",
          url: `/api/files/uploads/${intent.id}/bytes`,
          validUntil: intent.tokenExpiresAt!.getTime(),
          maximumSizeInBytes: intent.sizeBytes,
        }
      },
      async read(reference) {
        assertFileReference(reference)
        const path = resolve(root, reference)
        try {
          await access(path)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
          throw error
        }
        return Readable.toWeb(
          createReadStream(path)
        ) as ReadableStream<Uint8Array>
      },
      delete: (reference) => blobs.delete(reference),
    }
  }
  const token = env.BLOB_READ_WRITE_TOKEN!
  const path = (reference: string) => {
    assertFileReference(reference)
    return `forge/${reference}`
  }
  return {
    async grant(intent: UploadIntent) {
      const pathname = path(intent.storageReference)
      const validUntil = intent.tokenExpiresAt!.getTime()
      return {
        adapter: "vercel-private",
        pathname,
        validUntil,
        maximumSizeInBytes: intent.sizeBytes,
        token: await generateClientTokenFromReadWriteToken({
          token,
          pathname,
          validUntil,
          maximumSizeInBytes: intent.sizeBytes,
          allowedContentTypes: ["application/octet-stream"],
          addRandomSuffix: false,
          allowOverwrite: false,
        }),
      }
    },
    async read(reference) {
      const result = await get(path(reference), {
        token,
        access: "private",
        useCache: false,
      })
      if (!result) return null
      if (result.statusCode !== 200)
        throw new Error("Unexpected private upload response.")
      return result.stream
    },
    async delete(reference) {
      await del(path(reference), { token })
    },
  }
}
