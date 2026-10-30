import "@tanstack/react-start/server-only"
import { z } from "zod"
import { ApplicationAccessError } from "../authorization"
import { readUploadJson } from "./upload-http-handler.server"
import { UploadError } from "./upload-contract"
import { FileDeliveryError, fileTargetSchema } from "./file-delivery-contract"
import {
  FILE_RESPONSE_HEADERS,
  downloadFileResponse,
  previewFileResponse,
} from "./file-response.server"
import type { Actor } from "../actor"
import type { FileDeliveryService } from "./file-delivery-service.server"

export function createFileDeliveryHttpHandler(deps: {
  getActor: (request: Request) => Promise<Actor>
  service: FileDeliveryService
}) {
  return async (request: Request) => {
    const json = (value: unknown, status = 200) =>
      Response.json(value, { status, headers: FILE_RESPONSE_HEADERS })
    try {
      const url = new URL(request.url)
      const match =
        /^\/api\/files\/(resources|artifacts|attachments)\/([^/]+)\/(grant|download|preview)$/.exec(
          url.pathname
        )
      if (
        !match ||
        (match[3] === "grant"
          ? request.method !== "POST"
          : request.method !== "GET")
      )
        return json({ error: { code: "NOT_FOUND" } }, 404)
      const origin = request.headers.get("origin")
      if (
        (origin && origin !== url.origin) ||
        request.headers.get("sec-fetch-site") === "cross-site" ||
        (match[3] === "grant" && origin !== url.origin)
      )
        throw new ApplicationAccessError()
      const actor = await deps.getActor(request)
      const target = fileTargetSchema.parse({ kind: match[1], id: match[2] })
      if (match[3] === "grant") {
        const input = z
          .object({ purpose: z.enum(["download", "preview"]) })
          .strict()
          .parse(await readUploadJson(request))
        return json(await deps.service.grant(actor, target, input.purpose))
      }
      const token = z
        .string()
        .min(20)
        .max(2048)
        .parse(url.searchParams.get("token"))
      const purpose = match[3] === "preview" ? "preview" : "download"
      const { file, content } = await deps.service.read(
        actor,
        target,
        purpose,
        token
      )
      return purpose === "download"
        ? downloadFileResponse(file, content)
        : previewFileResponse(file, content)
    } catch (error) {
      if (error instanceof ApplicationAccessError)
        return json(
          {
            error: {
              code: "FILE_NOT_FOUND",
              message: "The file is unavailable or you no longer have access.",
            },
          },
          404
        )
      if (error instanceof FileDeliveryError)
        return json(
          { error: { code: error.code, message: error.message } },
          error.code === "UNAUTHENTICATED"
            ? 401
            : error.code === "INVALID_FILE_GRANT"
              ? 403
              : error.code === "PREVIEW_UNAVAILABLE"
                ? 415
                : error.code === "FILE_NOT_FOUND"
                  ? 404
                  : 503
        )
      if (error instanceof z.ZodError || error instanceof UploadError)
        return json({ error: { code: "INVALID_REQUEST" } }, 400)
      return json(
        {
          error: {
            code: "FILE_UNAVAILABLE",
            message: "The file could not be read. Try again.",
          },
        },
        503
      )
    }
  }
}
