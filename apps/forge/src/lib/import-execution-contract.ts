import { z } from "zod"
import type { issueDraftSchema } from "./issue-record-contract"
import type { initiativeProjectSchema } from "./initiatives"

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
  choice: z.enum(["keep-server", "keep-both", "skip", "migrate-files"]),
  conflictFingerprint: z.string().length(64),
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
  kind: "issue" | "project"
  teamId: string
  teamIds?: Array<string>
  fingerprint: string
  title: string
  draft?: z.infer<typeof issueDraftSchema>
  project?: z.infer<typeof initiativeProjectSchema>
  files: Array<ImportFile>
  canonicalId?: string
  replaceLegacyFiles?: boolean
  sourceValid?: boolean
  state: "pending" | "review" | "quarantined" | "saved" | "skipped"
  message?: string
  conflict?: {
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
    choice: "keep-server" | "keep-both" | "skip" | "migrate-files"
    fingerprint: string
  }
}
export type ImportManifest = {
  version: 1
  policyVersion: 1
  id: string
  fingerprint: string
  workspaceId: string
  actorId: string
  revision: number
  automaticPaused?: boolean
  sources: Array<{ key: string; checksum: string; raw: string }>
  entries: Array<ImportEntry>
  exclusions: Array<string>
  createdAt: string
}
export type ImportSnapshot = Omit<ImportManifest, "sources"> & {
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
