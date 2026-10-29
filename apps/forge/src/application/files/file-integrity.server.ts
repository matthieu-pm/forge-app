import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"

export const fileChecksum = (content: Uint8Array) =>
  createHash("sha256").update(content).digest("hex")
export function fileContentMatches(
  content: Uint8Array,
  metadata: { checksum: string; sizeBytes: number }
) {
  return (
    content.byteLength === metadata.sizeBytes &&
    fileChecksum(content) === metadata.checksum
  )
}
