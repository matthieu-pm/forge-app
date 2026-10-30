import { z } from "zod"

export function isProductStorageKey(key: string) {
  if (/^forge[:.]/.test(key)) return true
  try {
    const parts = JSON.parse(key)
    return Array.isArray(parts) && parts[0] === "forge.preferences"
  } catch {
    return false
  }
}
export const productStateCommandSchema = z
  .object({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    commandKey: z.uuid(),
    key: z
      .string()
      .min(1)
      .max(500)
      .refine(isProductStorageKey, "Unknown product state namespace."),
    value: z.string().max(20_000_000).nullable(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict()
export type ProductStateCommand = z.infer<typeof productStateCommandSchema>
export type ProductStateSnapshot = {
  workspaceId: string
  userId: string
  sessionId: string
  entries: Array<{ key: string; value: string | null; revision: number }>
}
