import { z } from "zod"
import type { issueDraftSchema } from "./issue-record-contract"
import type { initiativeProjectSchema } from "./initiatives"
import type {
  ImportContent,
  ImportModules,
} from "@/application/imports/content-manifest"

export const IMPORT_VERSION = 1
export const importIdentitySchema = z.object({
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
})
export const importRequestSchema = importIdentitySchema.extend({
  id: z.uuid(),
  revision: z.number().int().nonnegative(),
})
export const importChoiceSchema = importRequestSchema.extend({
  entryId: z.string().min(1),
  choice: z.enum([
    "keep-server",
    "keep-both",
    "skip",
    "migrate-files",
    "confirm-content",
  ]),
  conflictFingerprint: z.string().length(64),
  ownershipConfirmed: z.literal(true).optional(),
})
export type ImportFile = {
  legacyId?: string
  width?: number
  name: string
  data: string
  checksum: string
  sizeBytes: number
  contentType: string
  attempt?: number
  fileId?: string
}
export type ImportEntry = {
  id: string
  sourceKey: string
  sourceChecksum?: string
  path: string
  legacyId: string
  legacyAliases?: Array<string>
  kind:
    | "issue"
    | "project"
    | "initiative"
    | "milestone"
    | "document"
    | "view"
    | "resource"
  teamId: string
  teamIds?: Array<string>
  fingerprint: string
  title: string
  draft?: z.infer<typeof issueDraftSchema>
  project?: z.infer<typeof initiativeProjectSchema>
  content?: ImportContent
  files: Array<ImportFile>
  canonicalId?: string
  replaceLegacyFiles?: boolean
  canonicalProjection?: boolean
  reviewRequired?: boolean
  targetFingerprint?: string
  sourceValid?: boolean
  state: "pending" | "review" | "quarantined" | "saved" | "skipped" | "waiting"
  message?: string
  reviewSummary?: string
  conflict?: {
    contentConfirmation?: {
      newRecord: boolean
      destination: string
      actorId: string
      workspaceId: string
      teamId: string
      policyVersion: number
      sourceChecksum?: string
      entryId: string
    }
    fingerprint: string
    candidates: Array<{
      id: string
      title: string
      revision: number
      details?: Record<string, string>
      canMigrateFiles?: boolean
    }>
  }
  decision?: {
    choice:
      "keep-server" | "keep-both" | "skip" | "migrate-files" | "confirm-content"
    ownershipConfirmed?: true
    fingerprint: string
  }
}
export type ImportReference = Pick<
  ImportEntry,
  | "id"
  | "sourceKey"
  | "sourceChecksum"
  | "legacyId"
  | "legacyAliases"
  | "kind"
  | "teamId"
  | "canonicalId"
> & { manifestId: string; state: "saved" }
export type ImportManifest = {
  version: 1
  contentVersion?: 2
  modules?: ImportModules
  policyVersion: 1
  id: string
  fingerprint: string
  workspaceId: string
  actorId: string
  revision: number
  automaticPaused?: boolean
  sourceErrors?: Array<string>
  reconciliation?: ImportReconciliation
  completedAt?: string
  cleanedAt?: string
  cleanedSources?: Array<{ key: string; checksum: string }>

  sources: Array<{ key: string; checksum: string; raw: string }>
  referenceContext?: Array<ImportReference>
  entries: Array<ImportEntry>
  exclusions: Array<string>
  createdAt: string
}
export type ImportSnapshot = Omit<
  ImportManifest,
  "sources" | "referenceContext"
> & {
  sources: Array<{ key: string; checksum: string }>
  totalCount?: number
  savedCount?: number
  pendingCount?: number
  fileCount?: number
}
export const importFileRequestSchema = importRequestSchema.extend({
  entryId: z.string().min(1),
  index: z.number().int().min(0).max(4),
  fileId: z.uuid(),
})

export type ImportReconciliation = {
  fingerprint: string
  checkedAt: string
  ready: boolean
  counts: {
    sources: number
    records: number
    saved: number
    skipped: number
    unresolved: number
    files: number
    verifiedFiles: number
  }
  discrepancyCount: number
  discrepancies: Array<{ entryId?: string; message: string }>
  retainedExclusions: number
}
export const importCutoverSchema = importRequestSchema.extend({
  action: z.enum(["reconcile", "complete", "cleanup"]),
  reportFingerprint: z.string().length(64).optional(),
  acknowledgeExclusions: z.boolean().default(false),
})
