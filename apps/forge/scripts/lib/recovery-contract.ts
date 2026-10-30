import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import { recoveryEvent } from "../../src/application/recovery/journal"

const sha = z.string().regex(/^[a-f0-9]{64}$/)
const time = z.string().datetime()
export const recoveryIdentity = z
  .object({
    branchId: z.string().regex(/^br-/),
    host: z.string().endsWith(".neon.tech"),
    database: z.string().min(1),
    storeId: z.string().regex(/^store_[A-Za-z0-9]+$/),
  })
  .strict()
export const archiveEntry = z
  .object({
    entry: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,127}$/),
    sha256: sha,
    size: z.number().int().nonnegative(),
  })
  .strict()
export const tableFingerprint = z
  .object({
    table: z.string(),
    count: z.number().int().nonnegative(),
    sha256: sha,
  })
  .strict()
export const fileRecord = z
  .object({
    reference: z.string(),
    checksum: sha,
    size: z.number().int().nonnegative(),
    entry: archiveEntry,
  })
  .strict()
export const recoveryManifest = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    capturedAt: time,
    completedAt: time,
    expiresAt: time,
    source: recoveryIdentity,
    database: archiveEntry,
    schemaSha256: sha,
    tables: z.array(tableFingerprint),
    files: z.array(fileRecord),
    credentialKey: archiveEntry,
    credentialKeyFormat: z.enum(["raw", "rsa-capsule"]).optional(),
    journalKey: archiveEntry.optional(),
    credentialCounts: z
      .object({
        model: z.number().int().nonnegative(),
        meeting: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
export type RecoveryManifest = z.infer<typeof recoveryManifest>
export type RecoveryIdentity = z.infer<typeof recoveryIdentity>

// Owning deletion adapters export minimal exact row identities, children before
// parents. Unknown scopes fail closed; restore does not invent deletion semantics.
export const suppressionTables = [
  "session",
  "apikey",
  "model_connections",
  "call_connections",
  "resource_files",
  "agent_artifacts",
  "agent_attachments",
  "issues",
  "documents",
  "calls",
] as const
const journalPayload = z
  .object({
    version: z.literal(1),
    source: recoveryIdentity,
    from: time,
    through: time,
    entries: z.array(
      z.union([
        z
          .object({
            sequence: z.number().int().positive(),
            at: time,
            table: z.enum(suppressionTables),
            id: z.string().min(1).max(200),
          })
          .strict(),
        z
          .object({
            sequence: z.number().int().positive(),
            at: time,
            change: recoveryEvent,
          })
          .strict(),
      ])
    ),
  })
  .strict()
export const deletionJournal = journalPayload
  .extend({ signature: sha })
  .strict()
export type DeletionJournal = z.infer<typeof deletionJournal>
export function signJournal(
  payload: z.infer<typeof journalPayload>,
  key: Buffer
): DeletionJournal {
  const parsed = journalPayload.parse(payload)
  return {
    ...parsed,
    signature: createHmac("sha256", key)
      .update(JSON.stringify(parsed))
      .digest("hex"),
  }
}
export function verifyJournal(
  value: unknown,
  key: Buffer,
  manifest: RecoveryManifest,
  incidentAt: string
) {
  const journal = deletionJournal.parse(value)
  const { signature, ...payload } = journal
  const expected = signJournal(payload, key).signature
  if (
    !timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex")
    )
  )
    throw new Error("RECOVERY_JOURNAL_SIGNATURE")
  if (JSON.stringify(journal.source) !== JSON.stringify(manifest.source))
    throw new Error("RECOVERY_JOURNAL_SOURCE")
  const incident = Date.parse(incidentAt),
    from = Date.parse(journal.from),
    through = Date.parse(journal.through)
  if (
    !Number.isFinite(incident) ||
    from > Date.parse(manifest.capturedAt) ||
    through < incident ||
    through < from
  )
    throw new Error("RECOVERY_JOURNAL_COVERAGE")
  for (const [index, entry] of journal.entries.entries())
    if (
      entry.sequence !== index + 1 ||
      Date.parse(entry.at) < from ||
      Date.parse(entry.at) > through ||
      (index > 0 && entry.at < journal.entries[index - 1].at)
    )
      throw new Error("RECOVERY_JOURNAL_SEQUENCE")
  return journal
}
export function assertRecoveryWindow(
  manifest: RecoveryManifest,
  now: Date,
  incidentAt: string
) {
  const capture = Date.parse(manifest.capturedAt),
    complete = Date.parse(manifest.completedAt),
    expires = Date.parse(manifest.expiresAt),
    incident = Date.parse(incidentAt)
  if (
    ![capture, complete, expires, incident, now.getTime()].every(
      Number.isFinite
    ) ||
    capture > complete ||
    complete > incident ||
    incident > now.getTime() ||
    expires > capture + 35 * 86400000 ||
    expires <= capture ||
    now.getTime() >= expires
  )
    throw new Error("RECOVERY_CAPTURE_WINDOW")
  return { rpoSeconds: (incident - capture) / 1000 }
}
export function assessRecoveryTimings(
  capturedAt: string,
  incidentAt: string,
  validatedAt: string
) {
  const rpoSeconds = (Date.parse(incidentAt) - Date.parse(capturedAt)) / 1000
  const rtoSeconds = (Date.parse(validatedAt) - Date.parse(incidentAt)) / 1000
  const failures: Array<string> = []
  if (!Number.isFinite(rpoSeconds) || rpoSeconds < 0 || rpoSeconds > 3600)
    failures.push("RPO_EXCEEDED_OR_INVALID")
  if (!Number.isFinite(rtoSeconds) || rtoSeconds < 0 || rtoSeconds > 14400)
    failures.push("RTO_EXCEEDED_OR_INVALID")
  return { rpoSeconds, rtoSeconds, failures, passed: failures.length === 0 }
}
