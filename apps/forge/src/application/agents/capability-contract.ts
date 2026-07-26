import { z } from "zod"

export const CAPABILITY_RISKS = [
  "read",
  "reversible-write",
  "important-write",
  "destructive",
] as const

export type CapabilityRisk = (typeof CAPABILITY_RISKS)[number]

export const capabilityDescriptorSchema = z
  .object({
    id: z.string().trim().min(1).max(255),
    version: z.string().trim().min(1).max(50),
    summary: z.string().trim().min(1).max(500),
    risk: z.enum(CAPABILITY_RISKS),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()),
    maxResultBytes: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024),
  })
  .strict()

export type CapabilityDescriptor = z.infer<typeof capabilityDescriptorSchema>

export const capabilityInvocationSchema = z
  .object({
    capabilityId: z.string().trim().min(1).max(255),
    capabilityVersion: z.string().trim().min(1).max(50),
    input: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string().trim().min(1).max(255).optional(),
    approvalId: z.string().uuid().optional(),
  })
  .strict()

export type CapabilityInvocation = z.infer<typeof capabilityInvocationSchema>

export const capabilityResultSchema = z
  .object({
    ok: z.boolean(),
    value: z.unknown().optional(),
    errorCode: z.string().trim().min(1).max(100).optional(),
    errorMessage: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.ok
        ? value.errorCode === undefined && value.errorMessage === undefined
        : value.errorCode !== undefined && value.errorMessage !== undefined,
    "Capability results must contain either a value or a structured error."
  )

export type CapabilityResult = z.infer<typeof capabilityResultSchema>
