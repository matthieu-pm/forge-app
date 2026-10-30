import "@tanstack/react-start/server-only"
import { createWriteStream } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { inspectFileStorage } from "../../../../../packages/environment/file-storage"
import { DrizzleUploadStore } from "./drizzle-upload-store.server"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"
import type { Actor } from "@/application/actor"
import { assertFileReference } from "@/application/files/blob-store"
import { UploadError } from "@/application/files/upload-contract"

/** Development only; deployed requests never accept file bytes. */
export async function writeLocalUpload(
  actor: Actor,
  id: string,
  request: Request
) {
  const config = inspectFileStorage(process.env)
  if (config.issues.length || config.adapter !== "local")
    throw new UploadError(
      "INVALID_UPLOAD",
      "File bytes must be uploaded directly to private storage."
    )
  const intent = await new DrizzleUploadStore().prepare(actor, id)
  if (
    intent.state !== "pending" ||
    !intent.tokenExpiresAt ||
    intent.tokenExpiresAt <= new Date() ||
    !request.body
  )
    throw new UploadError(
      "INVALID_UPLOAD",
      "Request a new upload token before sending bytes."
    )
  assertFileReference(intent.storageReference)
  const path = resolve(
    process.env.FORGE_AGENT_ARTIFACT_DIRECTORY ?? ".forge/agent-artifacts",
    intent.storageReference
  )
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 })
  let received = 0,
    opened = false
  const destination = createWriteStream(path, { flags: "wx", mode: 0o600 })
  destination.once("open", () => {
    opened = true
  })
  try {
    await pipeline(
      Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length
          callback(
            received > intent.sizeBytes
              ? new UploadError(
                  "INVALID_UPLOAD",
                  "The file exceeds its reserved size."
                )
              : null,
            chunk
          )
        },
      }),
      destination
    )
  } catch (error) {
    if (opened) await rm(path, { force: true })
    throw error
  }
}
