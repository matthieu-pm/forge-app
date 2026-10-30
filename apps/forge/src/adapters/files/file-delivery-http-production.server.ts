import "@tanstack/react-start/server-only"
import { createFileBlobStore } from "./file-blob-store.server"
import { lookupAuthorizedFile } from "./file-delivery-lookup.server"
import { FileDeliveryService } from "@/application/files/file-delivery-service.server"
import { createFileDeliveryHttpHandler } from "@/application/files/file-delivery-http.server"
import { FileDeliveryError } from "@/application/files/file-delivery-contract"
import { ApplicationAccessError } from "@/application/authorization"
import { requireSessionActor } from "@/adapters/auth/session-actor.server"
import { WorkspaceAccessError } from "@/lib/auth-server"
import { EmailVerificationRequiredError } from "@/lib/email-verification"

let handler: ReturnType<typeof createFileDeliveryHttpHandler> | undefined
export function handleFileDeliveryRequest(request: Request) {
  handler ??= createFileDeliveryHttpHandler({
    getActor: async (incoming) => {
      try {
        return await requireSessionActor(incoming)
      } catch (error) {
        if (
          error instanceof WorkspaceAccessError &&
          error.code === "UNAUTHENTICATED"
        )
          throw new FileDeliveryError("UNAUTHENTICATED")
        if (
          error instanceof WorkspaceAccessError ||
          error instanceof EmailVerificationRequiredError
        )
          throw new ApplicationAccessError()
        throw error
      }
    },
    service: new FileDeliveryService({
      lookup: lookupAuthorizedFile,
      blobs: createFileBlobStore(),
    }),
  })
  return handler(request)
}
