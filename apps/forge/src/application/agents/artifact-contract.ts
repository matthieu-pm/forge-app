import { z } from "zod"

export const AGENT_ARTIFACT_KINDS = [
  "file",
  "text",
  "data",
  "report",
  "code",
] as const

export const createAgentArtifactInputSchema = z
  .object({
    kind: z.enum(AGENT_ARTIFACT_KINDS).default("file"),
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
        "Artifact names cannot contain paths or control characters."
      ),
    contentType: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]+\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
    content: z.string().max(8_000_000),
  })
  .strict()

export const agentArtifactRecordSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    kind: z.enum(AGENT_ARTIFACT_KINDS),
    name: z.string(),
    contentType: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    retentionExpiresAt: z.date().nullable(),
    deletedAt: z.date().nullable(),
    createdAt: z.date(),
  })
  .strict()

export type CreateAgentArtifactInput = z.infer<
  typeof createAgentArtifactInputSchema
>
export type AgentArtifactRecord = z.infer<typeof agentArtifactRecordSchema>
