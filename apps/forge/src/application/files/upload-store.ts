import type { Actor } from "../actor"
import type { ReadyUpload, UploadGrant, UploadInput } from "./upload-contract"

export type UploadIntent = UploadInput & {
  id: string
  workspaceId: string
  userId: string
  storageReference: string
  state: "pending" | "ready" | "rejected" | "expired"
  createdAt: Date
  expiresAt: Date
  tokenExpiresAt: Date | null
  attempts: Array<number>
  result: ReadyUpload | null
  rejectionReason: string | null
  cleanedAt: Date | null
}
export type VerifiedUpload = {
  sizeBytes: number
  checksum: string
  contentType: string
}
export interface UploadStore {
  create: (actor: Actor, input: UploadInput) => Promise<UploadIntent>
  /** Rechecks current authority, ownership, target, plan and fixed expiry on every call. */
  prepare: (
    actor: Actor,
    id: string,
    issueToken?: boolean
  ) => Promise<UploadIntent>
  /** Publishes metadata and settles reservation atomically, rechecking live policy. */
  publish: (
    actor: Actor,
    id: string,
    verified: VerifiedUpload
  ) => Promise<ReadyUpload>
  reject: (actor: Actor, id: string, reason: string) => Promise<void>
  cleanupCandidates: (
    before: Date,
    limit: number
  ) => Promise<Array<UploadIntent>>
  markCleaned: (id: string) => Promise<void>
}
export interface DirectUploadTransport {
  grant: (intent: UploadIntent) => Promise<UploadGrant>
  read: (reference: string) => Promise<ReadableStream<Uint8Array> | null>
  delete: (reference: string) => Promise<void>
}
