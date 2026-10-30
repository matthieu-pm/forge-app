import "@tanstack/react-start/server-only"
import { fileTypeFromBuffer } from "file-type"
import { UploadError } from "./upload-contract"

/** MIME is a classification, never an authorization grant or safe-preview claim. */
export async function inspectUploadType(
  head: Uint8Array,
  utf8Text: boolean,
  declared: string,
  jsonContent?: string
) {
  let detected: string | undefined
  try {
    detected = (await fileTypeFromBuffer(head))?.mime
  } catch {
    /* Truncated/unknown signatures fall back to generic bytes. */
  }
  if (utf8Text && declared === "application/json") {
    try {
      JSON.parse(jsonContent ?? "")
    } catch {
      throw new UploadError("INVALID_UPLOAD", "The file is not valid JSON.")
    }
  }
  const textTypes = new Set([
    "text/plain",
    "text/csv",
    "text/markdown",
    "application/json",
  ])
  const actual =
    detected ??
    (utf8Text
      ? textTypes.has(declared)
        ? declared
        : "text/plain"
      : "application/octet-stream")
  // Generic declarations permit detection, but cannot disguise a recognized format.
  if (
    declared !== "application/octet-stream" &&
    declared !== actual &&
    actual !== "application/octet-stream"
  )
    throw new UploadError(
      "INVALID_UPLOAD",
      "The file's bytes do not match its declared type."
    )
  return actual
}
