import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import {
  UPLOAD_LIMITS,
  UploadError,
  uploadInputSchema,
} from "./upload-contract"
import { inspectUploadType } from "./upload-type.server"
import type { Actor } from "../actor"
import type {
  DirectUploadTransport,
  UploadStore,
  VerifiedUpload,
} from "./upload-store"

/** Bytes travel client → private storage. The app receives bounded metadata only. */
export class UploadService {
  constructor(
    readonly store: UploadStore,
    readonly transport: DirectUploadTransport
  ) {}

  async create(actor: Actor, input: unknown) {
    const intent = await this.store.create(
      actor,
      uploadInputSchema.parse(input)
    )
    return {
      id: intent.id,
      state: intent.state,
      expiresAt: intent.expiresAt.toISOString(),
      result: intent.result,
    }
  }
  async token(actor: Actor, id: string) {
    try {
      const intent = await this.store.prepare(actor, id, true)
      if (intent.result)
        return { state: "ready" as const, result: intent.result }
      return {
        state: "pending" as const,
        upload: await this.transport.grant(intent),
      }
    } catch (error) {
      await this.rejectPermanentFailure(actor, id, error)
      throw error
    }
  }
  private async rejectPermanentFailure(
    actor: Actor,
    id: string,
    error: unknown
  ) {
    if (
      (error instanceof UploadError && error.code === "INVALID_UPLOAD") ||
      (error instanceof Error && error.name === "ApplicationAccessError")
    )
      await this.store.reject(
        actor,
        id,
        error instanceof Error ? error.message : "Upload refused."
      )
  }
  async finalize(actor: Actor, id: string) {
    try {
      const intent = await this.store.prepare(actor, id)
      if (intent.result) return intent.result
      const stream = await this.transport.read(intent.storageReference)
      if (!stream)
        throw new UploadError(
          "UPLOAD_UNAVAILABLE",
          "Upload the file before finalizing it."
        )
      const reader = stream.getReader()
      const hash = createHash("sha256")
      const head = new Uint8Array(Math.min(intent.sizeBytes, 1_048_576))
      let sizeBytes = 0,
        headBytes = 0,
        text = true
      let jsonContent = ""
      const jsonDecoder = new TextDecoder("utf-8", { fatal: true })
      const decoder = new TextDecoder("utf-8", { fatal: true })
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          sizeBytes += value.byteLength
          if (
            sizeBytes > intent.sizeBytes ||
            sizeBytes > UPLOAD_LIMITS.maxBytes
          )
            throw new UploadError(
              "INVALID_UPLOAD",
              "The stored file exceeds its reserved size."
            )
          hash.update(value)
          const take = Math.min(head.length - headBytes, value.byteLength)
          head.set(value.subarray(0, take), headBytes)
          headBytes += take
          if (text) {
            try {
              if (intent.contentType === "application/json")
                jsonContent += jsonDecoder.decode(value, { stream: true })
              if (
                // eslint-disable-next-line no-control-regex -- reject binary control bytes in UTF-8 text
                /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(
                  decoder.decode(value, { stream: true })
                )
              )
                text = false
            } catch {
              text = false
            }
          }
        }
        if (text) {
          try {
            decoder.decode()
            if (intent.contentType === "application/json")
              jsonContent += jsonDecoder.decode()
          } catch {
            text = false
          }
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      const checksum = hash.digest("hex")
      if (sizeBytes !== intent.sizeBytes || checksum !== intent.checksum)
        throw new UploadError(
          "INVALID_UPLOAD",
          "The stored file does not match its size or SHA-256 checksum."
        )
      const contentType = await inspectUploadType(
        head.subarray(0, headBytes),
        text,
        intent.contentType,
        jsonContent
      )
      const verified: VerifiedUpload = { sizeBytes, checksum, contentType }
      return await this.store.publish(actor, id, verified)
    } catch (error) {
      // Transport outages and missing bytes are retryable. Policy/integrity failures
      // permanently release the reservation, retaining inventory for delayed cleanup.
      await this.rejectPermanentFailure(actor, id, error)
      throw error
    }
  }
  async cancel(actor: Actor, id: string) {
    // Ownership-scoped rejection is allowed after revocation; it can only remove a reservation.
    await this.store.reject(actor, id, "Upload cancelled.")
    return { ok: true }
  }
  async sweep(before = new Date(), limit = 100) {
    const candidates = await this.store.cleanupCandidates(
      before,
      Math.max(1, Math.min(limit, 1000))
    )
    const failures: Array<string> = []
    let deleted = 0
    for (const intent of candidates) {
      try {
        await this.transport.delete(intent.storageReference)
        await this.store.markCleaned(intent.id)
        deleted++
      } catch {
        failures.push(intent.id)
      }
    }
    return { examined: candidates.length, deleted, failures }
  }
}
