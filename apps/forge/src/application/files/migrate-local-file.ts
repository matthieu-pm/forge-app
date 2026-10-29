import { createHash } from "node:crypto"
import type { FileBlobStore } from "./blob-store"

/** Keep the existing reference/metadata, prove byte identity, never remove source bytes. */
export async function migrateLocalFile(input: {
  reference: string
  checksum: string
  sizeBytes: number
  source: FileBlobStore
  destination: FileBlobStore
  apply: boolean
}) {
  const matches = (bytes: Uint8Array) =>
    bytes.byteLength === input.sizeBytes &&
    createHash("sha256").update(bytes).digest("hex") === input.checksum
  const existing = await input.destination.get(input.reference)
  if (existing) {
    if (!matches(existing))
      throw new Error("Destination file integrity mismatch.")
    return "already-durable" as const
  }
  const content = await input.source.get(input.reference)
  if (!content || !matches(content))
    throw new Error("Source file is unavailable or failed its integrity check.")
  if (!input.apply) return "requires-copy" as const
  try {
    await input.destination.put(input.reference, content)
  } catch {
    // A concurrent retry may have created the exact object. Read back; never overwrite.
    const concurrent = await input.destination.get(input.reference)
    if (!concurrent || !matches(concurrent))
      throw new Error("Private file copy failed.")
  }
  const verified = await input.destination.get(input.reference)
  if (!verified || !matches(verified))
    throw new Error("Private file read-back failed its integrity check.")
  return "copied" as const
}
