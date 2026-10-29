import "@tanstack/react-start/server-only"
import { z } from "zod"
import type { FileBlobStore } from "@/application/files/blob-store"
import { fileChecksum } from "@/application/files/file-integrity.server"

/** Only one random, operator-configured synthetic object; never accepts a user file key. */
export async function checkPrivateStorage(input: {
  action: unknown
  objectId: string | undefined
  blobs: FileBlobStore
}) {
  const id = z.uuid().parse(input.objectId)
  const action = z.enum(["write", "read", "delete"]).parse(input.action)
  const reference = `files/${id}`
  const content = new TextEncoder().encode(
    `FOR-34 private production verification ${id}`
  )
  const checksum = fileChecksum(content)
  if (action === "write") await input.blobs.put(reference, content)
  if (action === "delete") await input.blobs.delete(reference)
  const actual = await input.blobs.get(reference)
  const matches =
    actual !== null &&
    actual.byteLength === content.byteLength &&
    fileChecksum(actual) === checksum
  if (action === "delete" ? actual !== null : !matches)
    throw new Error("Private storage check failed.")
  return {
    action,
    checksum,
    sizeBytes: content.byteLength,
    verified: true,
    deleted: action === "delete",
  }
}
