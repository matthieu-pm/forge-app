import { z } from "zod"

const acknowledgement = z.object({
  inserted: z.number().int().min(0).max(1),
  duplicates: z.number().int().min(0).max(1).default(0),
})
/** One durable outbox record per call. A duplicate ACK proves deduplication,
 * not matching payload bytes: verify the immutable local body hash first. */
export function singlePolarUsageAcknowledgement(value: unknown) {
  const parsed = acknowledgement.parse(value)
  if (parsed.inserted + parsed.duplicates !== 1)
    throw new Error("POLAR_USAGE_ACKNOWLEDGEMENT_INCOMPLETE")
  return parsed.inserted === 1 ? ("inserted" as const) : ("duplicate" as const)
}
