import "@tanstack/react-start/server-only"
import { createForgeUploadService } from "./forge-upload-service.server"
import { writeLocalUpload } from "./write-local-upload.server"
import { ApplicationAccessError } from "@/application/authorization"
import { UploadError } from "@/application/files/upload-contract"
import { WorkspaceAccessError } from "@/lib/auth-server"
import { EmailVerificationRequiredError } from "@/lib/email-verification"
import { requireSessionActor } from "@/adapters/auth/session-actor.server"
import { createUploadHttpHandler } from "@/application/files/upload-http-handler.server"

let handler: ReturnType<typeof createUploadHttpHandler> | undefined
export function handleUploadRequest(request: Request) {
  handler ??= createUploadHttpHandler({
    getActor: async (request) => {
      try {
        return await requireSessionActor(request)
      } catch (error) {
        if (error instanceof WorkspaceAccessError) {
          if (error.code === "UNAUTHENTICATED")
            throw new UploadError("UNAUTHENTICATED", "Sign in to upload files.")
          throw new ApplicationAccessError(
            "Select a workspace you can access before uploading files."
          )
        }
        if (error instanceof EmailVerificationRequiredError)
          throw new ApplicationAccessError(error.message)
        throw error
      }
    },
    service: createForgeUploadService(),
    writeLocal: writeLocalUpload,
  })
  return handler(request)
}
