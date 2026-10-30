import "@tanstack/react-start/server-only"
import { z } from "zod"
import { ApplicationAccessError } from "../authorization"
import { UploadError } from "./upload-contract"
import type { Actor } from "../actor"
import type { UploadService } from "./upload-service.server"

export async function readUploadJson(request: Request) {
  const reader = request.body?.getReader()
  if (!reader)
    throw new UploadError("INVALID_UPLOAD", "A JSON request body is required.")
  let size = 0
  const chunks: Array<Uint8Array> = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8192)
        throw new UploadError(
          "INVALID_UPLOAD",
          "Upload metadata cannot exceed 8192 bytes. Send file bytes directly to storage."
        )
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown
  } catch {
    throw new UploadError("INVALID_UPLOAD", "Invalid upload metadata JSON.")
  }
}
export function createUploadHttpHandler(deps: {
  getActor: (request: Request) => Promise<Actor>
  service: UploadService
  writeLocal?: (actor: Actor, id: string, request: Request) => Promise<void>
}) {
  return async (request: Request) => {
    const json = (
      value: unknown,
      status = 200,
      extra: Record<string, string> = {}
    ) =>
      Response.json(value, {
        status,
        headers: { "cache-control": "no-store", ...extra },
      })
    try {
      const origin = request.headers.get("origin")
      if (!origin || new URL(origin).origin !== new URL(request.url).origin)
        throw new ApplicationAccessError("The request origin is not allowed.")
      const actor = await deps.getActor(request)
      const path = new URL(request.url).pathname.replace(/\/$/, "")
      const match =
        /^\/api\/files\/uploads(?:\/([a-f0-9-]+)\/(token|finalize|cancel|bytes))?$/.exec(
          path
        )
      if (!match || !["POST", "PUT"].includes(request.method))
        return json(
          { error: { code: "NOT_FOUND", message: "Upload route not found." } },
          404
        )
      if (!match[1] && request.method === "POST")
        return json(
          await deps.service.create(actor, await readUploadJson(request)),
          201
        )
      const id = z.uuid().parse(match[1])
      if (match[2] === "bytes" && request.method === "PUT" && deps.writeLocal) {
        await deps.writeLocal(actor, id, request)
        return json({ ok: true })
      }
      if (request.method !== "POST")
        return json(
          { error: { code: "NOT_FOUND", message: "Upload route not found." } },
          404
        )
      // Action endpoints accept no client object metadata or arbitrary storage URLs.
      if (request.body) {
        const body = await readUploadJson(request)
        z.object({}).strict().parse(body)
      }
      if (match[2] === "token") return json(await deps.service.token(actor, id))
      if (match[2] === "finalize")
        return json(await deps.service.finalize(actor, id))
      if (match[2] === "cancel")
        return json(await deps.service.cancel(actor, id))
      return json(
        { error: { code: "NOT_FOUND", message: "Upload route not found." } },
        404
      )
    } catch (error) {
      if (error instanceof ApplicationAccessError)
        return json(
          { error: { code: error.code, message: error.message } },
          403
        )
      if (error instanceof z.ZodError)
        return json(
          {
            error: {
              code: "INVALID_UPLOAD",
              message: "Invalid upload metadata.",
            },
          },
          400
        )
      if (error instanceof UploadError)
        return json(
          { error: { code: error.code, message: error.message } },
          error.code === "UNAUTHENTICATED"
            ? 401
            : error.code === "UPLOAD_CONFLICT"
              ? 409
              : error.code === "UPLOAD_LIMIT"
                ? 429
                : error.code === "UPLOAD_UNAVAILABLE"
                  ? 409
                  : 400,
          error.retryAfterSeconds
            ? { "retry-after": String(error.retryAfterSeconds) }
            : {}
        )
      return json(
        {
          error: {
            code: "UPLOAD_UNAVAILABLE",
            message:
              "The upload could not be completed. Retry using the same upload intent.",
          },
        },
        503
      )
    }
  }
}
