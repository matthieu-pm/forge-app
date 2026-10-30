import { z } from "zod"

export const fileTargetSchema = z
  .object({
    kind: z.enum(["resources", "artifacts", "attachments"]),
    id: z.uuid(),
  })
  .strict()
export type FileTarget = z.infer<typeof fileTargetSchema>
export type FilePurpose = "download" | "preview"
export const FILE_GRANT_SECONDS = 300
export const FILE_DELIVERY_MAX_BYTES = 100_000_000
export const FILE_PREVIEW_MAX_BYTES = 1_000_000

export class FileDeliveryError extends Error {
  constructor(
    readonly code:
      | "FILE_NOT_FOUND"
      | "INVALID_FILE_GRANT"
      | "FILE_UNAVAILABLE"
      | "PREVIEW_UNAVAILABLE"
      | "UNAUTHENTICATED"
  ) {
    super(
      {
        FILE_NOT_FOUND: "The file is unavailable or you no longer have access.",
        INVALID_FILE_GRANT:
          "The file link is invalid or expired. Request a new link.",
        FILE_UNAVAILABLE: "The file could not be read. Try again.",
        PREVIEW_UNAVAILABLE:
          "A preview is unavailable for this file. Download it to view it.",
        UNAUTHENTICATED: "Sign in to access files.",
      }[code]
    )
    this.name = "FileDeliveryError"
  }
}
