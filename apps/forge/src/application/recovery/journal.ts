import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"

export const journalSource = z
  .object({
    branchId: z.string().regex(/^br-/),
    host: z.string().endsWith(".neon.tech"),
    database: z.string().min(1),
    storeId: z.string().regex(/^store_[A-Za-z0-9]+$/),
  })
  .strict()
export type JournalSource = z.infer<typeof journalSource>
const identifier = z.string().regex(/^[a-z_][a-z0-9_]*$/)
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()])
export const patchFields = [
  "deleted_at",
  "expires_at",
  "enabled",
  "revoked_at",
  "role",
  "visibility",
  "status",
  "archived_at",
  "permissions",
  "scopes",
  "active_organization_id",
  "secret",
  "secret_reference",
  "access_token",
  "refresh_token",
  "password",
  "oauth_verifier",
  "oauth_state_hash",
  "transcript",
  "state",
  "email_verified",
  "version",
  "invite_links_enabled",
  "invite_link_version",
  "google_authentication_enabled",
  "email_passkey_authentication_enabled",
  "invitation_policy",
  "team_creation_policy",
  "workspace_labels_policy",
  "workspace_templates_policy",
  "loops_policy",
  "api_key_creation_policy",
  "agent_guidance_policy",
  "restrict_file_uploads",
  "allowed_upload_types",
  "review_third_party_applications",
  "reduce_support_pii",
  "block_guest_agent_access",
  "share_ai_usage_data",
  "agent_web_search_enabled",
  "external_loop_sources_enabled",
  "mcp_servers_enabled",
  "hipaa_enabled",
] as const
export const recoveryEvent = z
  .object({
    id: z.string().uuid(),
    sequence: z.number().int().positive(),
    table: identifier,
    key: z.record(identifier, scalar).refine((x) => Object.keys(x).length > 0),
    action: z.enum(["delete", "patch"]),
    patch: z.partialRecord(z.enum(patchFields), z.json()).nullable(),
    storageReference: z.string().nullable(),
    at: z.string().datetime(),
  })
  .strict()
  .superRefine((event, ctx) => {
    const secrets = [
      "secret",
      "secret_reference",
      "access_token",
      "refresh_token",
      "password",
      "oauth_verifier",
      "oauth_state_hash",
    ]
    if (event.action === "delete" && event.patch !== null)
      ctx.addIssue({
        code: "custom",
        message: "Delete patches must be absent.",
      })
    if (
      event.action === "patch" &&
      (!event.patch || Object.keys(event.patch).length === 0)
    )
      ctx.addIssue({ code: "custom", message: "A patch is required." })
    for (const [key, value] of Object.entries(event.patch ?? {})) {
      if (secrets.includes(key) && value !== null)
        ctx.addIssue({
          code: "custom",
          message: "Credential content cannot enter a deletion journal.",
        })
      if (key === "transcript" && JSON.stringify(value) !== "[]")
        ctx.addIssue({
          code: "custom",
          message: "Only transcript suppression is allowed.",
        })
    }
  })
export type RecoveryEvent = z.infer<typeof recoveryEvent>
export const journalRecord = z
  .object({
    version: z.literal(1),
    source: journalSource,
    operationId: z.string().uuid(),
    at: z.string().datetime(),
    kind: z.enum(["prepared", "chunk", "completed", "aborted"]),
    events: z.array(recoveryEvent).max(1000).optional(),
    chunks: z.array(z.string().regex(/^chunk-\d+\.json$/)).optional(),
  })
  .strict()
export type JournalRecord = z.infer<typeof journalRecord>
export const sourceDigest = (source: JournalSource) =>
  createHash("sha256")
    .update(JSON.stringify(journalSource.parse(source)))
    .digest("hex")
export function signJournalRecord(record: JournalRecord, key: Buffer) {
  const parsed = journalRecord.parse(record)
  if (
    (parsed.kind === "chunk" &&
      (!parsed.events || parsed.chunks !== undefined)) ||
    (parsed.kind === "completed" &&
      (!parsed.chunks ||
        parsed.events !== undefined ||
        parsed.chunks.some((name, index) => name !== `chunk-${index}.json`))) ||
    ((parsed.kind === "prepared" || parsed.kind === "aborted") &&
      (parsed.events !== undefined || parsed.chunks !== undefined))
  )
    throw new Error("RECOVERY_JOURNAL_RECORD_SHAPE")
  return {
    ...parsed,
    signature: createHmac("sha256", key)
      .update(JSON.stringify(parsed))
      .digest("hex"),
  }
}
export function verifyJournalRecord(value: unknown, key: Buffer) {
  const signed = journalRecord
    .extend({ signature: z.string().regex(/^[a-f0-9]{64}$/) })
    .parse(value)
  const { signature, ...record } = signed
  if (
    !timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(signJournalRecord(record, key).signature, "hex")
    )
  )
    throw new Error("RECOVERY_JOURNAL_SIGNATURE")
  return record
}
export interface DeletionJournalBackend {
  prepare: (operationId: string, source: JournalSource) => Promise<void>
  complete: (
    operationId: string,
    source: JournalSource,
    events: AsyncIterable<Array<RecoveryEvent>>
  ) => Promise<void>
  abort: (operationId: string, source: JournalSource) => Promise<void>
}
