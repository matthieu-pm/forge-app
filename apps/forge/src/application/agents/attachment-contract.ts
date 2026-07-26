import { z } from "zod"

const SAFE_ATTACHMENT_TYPES = new Set([
  "application/json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain",
])

export const createAgentAttachmentInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine(
        (value) =>
          !value.includes("/") &&
          !value.includes("\\") &&
          ![...value].some((character) => {
            const code = character.charCodeAt(0)
            return code <= 31 || code === 127
          }),
        "Attachment names cannot contain paths or control characters."
      ),
    contentType: z
      .string()
      .trim()
      .toLowerCase()
      .refine(
        (value) => SAFE_ATTACHMENT_TYPES.has(value),
        "This attachment type is not supported."
      ),
    contentBase64: z
      .string()
      .min(1)
      .max(8_000_000)
      .regex(/^[a-z0-9+/]*={0,2}$/i),
  })
  .strict()

export const agentAttachmentRecordSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    contentType: z.string(),
    sizeBytes: z.number().int().positive(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.date(),
    createdAt: z.date(),
  })
  .strict()

export type CreateAgentAttachmentInput = z.infer<
  typeof createAgentAttachmentInputSchema
>
export type AgentAttachmentRecord = z.infer<typeof agentAttachmentRecordSchema>

export type ResolvedAgentAttachment = AgentAttachmentRecord & {
  contentBase64: string
}
