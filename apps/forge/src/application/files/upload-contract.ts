import { z } from "zod"

export const UPLOAD_LIMITS = Object.freeze({
  maxBytes: 100_000_000,
  accountPending: 4,
  workspacePending: 16,
  accountHourlyBytes: 1_000_000_000,
  workspaceHourlyBytes: 10_000_000_000,
  attemptsPerHour: 5,
  lifetimeMs: 24 * 60 * 60_000,
  tokenMs: 10 * 60_000,
})
export const uploadTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent") }).strict(),
  z.object({ kind: z.enum(["issue", "document"]), id: z.uuid() }).strict(),
])
export const uploadInputSchema = z
  .object({
    commandKey: z.uuid(),
    target: uploadTargetSchema,
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine(
        (value) =>
          !value.includes("/") &&
          !value.includes("\\") &&
          ![...value].some(
            (c) => c.charCodeAt(0) <= 31 || c.charCodeAt(0) === 127
          ),
        "File names cannot contain paths or control characters."
      ),
    contentType: z
      .string()
      .trim()
      .toLowerCase()
      .max(120)
      .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/),
    sizeBytes: z.number().int().positive().max(UPLOAD_LIMITS.maxBytes),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type UploadInput = z.infer<typeof uploadInputSchema>
export type UploadTarget = UploadInput["target"]
export const readyUploadSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    contentType: z.string(),
    sizeBytes: z.number().int().positive(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict()
export type ReadyUpload = z.infer<typeof readyUploadSchema>
export type UploadGrant =
  | {
      adapter: "vercel-private"
      pathname: string
      token: string
      validUntil: number
      maximumSizeInBytes: number
    }
  | {
      adapter: "local"
      url: string
      validUntil: number
      maximumSizeInBytes: number
    }
export class UploadError extends Error {
  constructor(
    readonly code:
      | "UNAUTHENTICATED"
      | "INVALID_UPLOAD"
      | "UPLOAD_LIMIT"
      | "UPLOAD_CONFLICT"
      | "UPLOAD_UNAVAILABLE",
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message)
    this.name = "UploadError"
  }
}
