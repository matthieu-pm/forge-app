import "@tanstack/react-start/server-only"
import { DrizzleUploadStore } from "./drizzle-upload-store.server"
import { createDirectUploadTransport } from "./direct-upload-transport.server"
import { UploadService } from "@/application/files/upload-service.server"

export function createForgeUploadService() {
  return new UploadService(
    new DrizzleUploadStore(),
    createDirectUploadTransport()
  )
}
