import { put } from "@vercel/blob/client"
import type {
  ReadyUpload,
  UploadGrant,
  UploadTarget,
} from "@/application/files/upload-contract"
import { UPLOAD_LIMITS } from "@/application/files/upload-contract"

export class UploadClientError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "UploadClientError"
  }
}
export type UploadSessions = Map<string, { commandKey: string; id?: string }>
async function responseJson<T>(response: Response): Promise<T> {
  const value = (await response.json()) as T & {
    error?: { code?: string; message?: string }
  }
  if (!response.ok)
    throw new UploadClientError(
      value.error?.code ?? "UPLOAD_UNAVAILABLE",
      value.error?.message ?? "The file could not be uploaded."
    )
  return value
}
/** A retry reuses its intent, including when the upload/finalize response was lost. */
export async function uploadFileDirect(
  input: {
    name: string
    contentType: string
    file: Blob
    target: UploadTarget
  },
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  sessions: UploadSessions = new Map()
) {
  if (input.file.size <= 0 || input.file.size > UPLOAD_LIMITS.maxBytes)
    throw new UploadClientError(
      "INVALID_UPLOAD",
      `Files must contain between 1 and ${UPLOAD_LIMITS.maxBytes} bytes (100 MB). Your plan may have a lower limit.`
    )
  const bytes = await input.file.arrayBuffer()
  const checksum = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
  const key = JSON.stringify([
    input.target,
    input.name,
    input.contentType,
    input.file.size,
    checksum,
  ])
  const session = sessions.get(key) ?? {
    commandKey: crypto.randomUUID(),
    id: undefined as string | undefined,
  }
  sessions.set(key, session)
  const post = <T>(path: string, body: unknown) =>
    fetcher(`/api/files/uploads${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(responseJson<T>)
  const finalize = () => post<ReadyUpload>(`/${session.id}/finalize`, {})
  try {
    if (session.id) {
      try {
        const ready = await finalize()
        sessions.delete(key)
        return ready
      } catch (error) {
        if (
          !(error instanceof UploadClientError) ||
          error.code !== "UPLOAD_UNAVAILABLE"
        )
          throw error
      }
    } else {
      const intent = await post<{
        id: string
        state: string
        result: ReadyUpload | null
      }>("/", {
        commandKey: session.commandKey,
        target: input.target,
        name: input.name,
        contentType: input.contentType,
        sizeBytes: input.file.size,
        checksum,
      })
      session.id = intent.id
      if (intent.result) {
        sessions.delete(key)
        return intent.result
      }
    }
    const result = await post<
      | { state: "pending"; upload: UploadGrant }
      | { state: "ready"; result: ReadyUpload }
    >(`/${session.id}/token`, {})
    if (result.state === "ready") {
      sessions.delete(key)
      return result.result
    }
    const grant = result.upload
    try {
      if (grant.adapter === "vercel-private") {
        await put(grant.pathname, input.file, {
          access: "private",
          token: grant.token,
          contentType: "application/octet-stream",
          multipart: input.file.size > 8_000_000,
        })
      } else {
        await responseJson(
          await fetcher(grant.url, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: input.file,
          })
        )
      }
    } catch (error) {
      // The provider may have committed bytes even if its acknowledgement was lost.
      try {
        const ready = await finalize()
        sessions.delete(key)
        return ready
      } catch {
        throw error
      }
    }
    const ready = await finalize()
    sessions.delete(key)
    return ready
  } catch (error) {
    if (
      error instanceof UploadClientError &&
      ["INVALID_UPLOAD", "FORBIDDEN", "UPLOAD_CONFLICT"].includes(error.code)
    )
      sessions.delete(key)
    throw error
  }
}
