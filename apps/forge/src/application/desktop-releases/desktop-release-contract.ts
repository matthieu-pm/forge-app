import { z } from "zod"

const desktopVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "Use a semantic version without a v prefix.")

const artifactSchema = z
  .object({
    platform: z.literal("darwin"),
    architecture: z.enum(["arm64", "x64"]),
    kind: z.enum(["dmg", "zip"]),
    objectKey: z
      .string()
      .regex(
        /^desktop\/v\d+\.\d+\.\d+\/darwin\/(arm64|x64)\/[A-Za-z0-9._/-]+$/
      ),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: z.number().int().positive(),
    notarizationRef: z.string().min(1).max(500).optional(),
  })
  .strict()

export const registerDesktopReleaseSchema = z
  .object({
    version: desktopVersionSchema,
    releaseNotes: z.string().max(20_000).default(""),
    artifacts: z.array(artifactSchema).min(1).max(4),
  })
  .strict()

export const desktopReleaseVersionSchema = desktopVersionSchema

export type RegisterDesktopReleaseInput = z.infer<
  typeof registerDesktopReleaseSchema
>
