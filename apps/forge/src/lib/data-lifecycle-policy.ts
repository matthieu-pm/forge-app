/** FOR-23 pure policy contract. Trusted adapters own authorization, clocks,
 * reference discovery, durable checkpoints and actual byte deletion. */
export const DATA_LIFECYCLE_POLICY_VERSION = 1
export const DAY_MS = 24 * 60 * 60 * 1_000
export const DELETION_RECOVERY_DAYS = 30
export const BACKUP_RETENTION_DAYS = 35
export const CALL_TRANSCRIPT_RETENTION_DAYS = [7, 30, 90, 365] as const
export type TranscriptRetentionDays =
  (typeof CALL_TRANSCRIPT_RETENTION_DAYS)[number]

export const retentionRules = {
  "call-transcript": { days: 30, anchor: "call-start" },
  "call-summary": { days: null, anchor: "explicit-deletion" },
  "call-decision": { days: null, anchor: "explicit-deletion" },
  "call-action": { days: null, anchor: "explicit-deletion" },
  "call-note": { days: null, anchor: "explicit-deletion" },
  "workspace-content": { days: null, anchor: "explicit-deletion" },
  "resource-file": { days: null, anchor: "owning-resource-deletion" },
  "account-profile-preferences": { days: null, anchor: "account-deletion" },
  "agent-conversation": { days: 90, anchor: "last-terminal-activity" },
  "agent-event": { days: 90, anchor: "last-terminal-activity" },
  "agent-summary": { days: 90, anchor: "last-terminal-activity" },
  "agent-input-file": { days: 1, anchor: "upload" },
  "agent-artifact": { days: 30, anchor: "creation" },
  "pending-upload": { days: 1, anchor: "upload-intent" },
  "export-file": { days: 1, anchor: "export-completion" },
  "failed-export-staging": { days: 1, anchor: "job-terminal" },
  "command-receipt": { days: 90, anchor: "command-terminal" },
  "import-manifest": { days: 90, anchor: "import-terminal" },
  "migration-alias": { days: null, anchor: "owning-resource-deletion" },
  "workflow-history": { days: 90, anchor: "workflow-terminal" },
  "operational-log": { days: 30, anchor: "event" },
  "security-audit": { days: 365, anchor: "event" },
  "deletion-receipt": { days: 365, anchor: "deletion-completion" },
  "server-backup": { days: BACKUP_RETENTION_DAYS, anchor: "backup-capture" },
  "local-import-backup": { days: null, anchor: "explicit-local-cleanup" },
} as const

export type RetainedDataClass = keyof typeof retentionRules

function timestamp(value: Date) {
  const time = value.getTime()
  if (!Number.isFinite(time)) throw new Error("Invalid lifecycle timestamp.")
  return time
}

function afterDays(anchor: Date, days: number) {
  const result = new Date(timestamp(anchor) + days * DAY_MS)
  timestamp(result)
  return result
}

/** null means no automatic age expiry, never immunity from explicit deletion. */
export function retentionDeadline(
  dataClass: RetainedDataClass,
  anchor: Date,
  transcriptDays?: TranscriptRetentionDays
): Date | null {
  timestamp(anchor)
  if (!Object.hasOwn(retentionRules, dataClass))
    throw new Error("Unknown retained data class.")
  if (
    transcriptDays !== undefined &&
    (dataClass !== "call-transcript" ||
      !CALL_TRANSCRIPT_RETENTION_DAYS.includes(transcriptDays))
  )
    throw new Error("Unsupported transcript retention setting.")
  const days =
    dataClass === "call-transcript"
      ? (transcriptDays ?? retentionRules[dataClass].days)
      : retentionRules[dataClass].days
  return days === null ? null : afterDays(anchor, days)
}

export function evaluateAgeRetention(input: {
  dataClass: RetainedDataClass
  anchor: Date
  now: Date
  transcriptDays?: TranscriptRetentionDays
  /** Trusted live references only. Never use these holds for ordinary exports. */
  activeRunNeedsData?: boolean
  unsettledCommandNeedsData?: boolean
}) {
  const now = timestamp(input.now)
  const deadline = retentionDeadline(
    input.dataClass,
    input.anchor,
    input.transcriptDays
  )
  if (!deadline) return "retain-until-deleted" as const
  if (now < timestamp(deadline)) return "retain" as const
  const agentData = input.dataClass.startsWith("agent-")
  if (
    (agentData && input.activeRunNeedsData) ||
    ((agentData || input.dataClass === "command-receipt") &&
      input.unsettledCommandNeedsData)
  )
    return "reconciliation-required" as const
  return "expire" as const
}

export const deletionPurgeTargets = [
  "credentials-and-jobs",
  "database-content",
  "object-bytes-and-versions",
  "search-and-caches",
  "exports-and-staging",
  "identity-and-memberships",
] as const
export type DeletionPurgeTarget = (typeof deletionPurgeTargets)[number]

export type DeletionProgress = {
  policyVersion: number
  /** Persist once after authorized confirmation; retries never restart this clock. */
  requestedAt: Date
  /** Attests session/key/grant/run revocation, not just a deleted membership row. */
  revocationRecorded: boolean
  purgeStartedAt: Date | null
  /** Server-verified completion times; a missing object counts as deleted. */
  checkpoints: Partial<Record<DeletionPurgeTarget, Date>>
  /** Attestation that all backups containing the data have expired, not an ETA. */
  backupExpiryVerifiedAt: Date | null
}

export function deletionRecoveryEndsAt(requestedAt: Date) {
  return afterDays(requestedAt, DELETION_RECOVERY_DAYS)
}

/** Eligibility only. Restoration additionally requires fresh trusted identity and
 * authority; it never revives old credentials or already expired content. */
export function canRecoverDeletion(
  progress: DeletionProgress,
  now: Date
): boolean {
  return evaluateDeletionProgress(progress, now).phase === "recoverable"
}

export type DeletionAssessment = {
  phase:
    | "invalid-progress"
    | "revocation-required"
    | "recoverable"
    | "purge-required"
    | "purging"
    | "awaiting-backup-expiry"
    | "backup-verification-required"
    | "completed"
  /** Content stays inaccessible throughout the deletion process. */
  ordinaryAccessAllowed: false
  backupExpiresBy?: Date
}

export function evaluateDeletionProgress(
  progress: DeletionProgress,
  now: Date
): DeletionAssessment {
  const result = (phase: DeletionAssessment["phase"]): DeletionAssessment => ({
    phase,
    ordinaryAccessAllowed: false,
  })
  try {
    const current = timestamp(now)
    const requested = timestamp(progress.requestedAt)
    const recoveryEnd = timestamp(deletionRecoveryEndsAt(progress.requestedAt))
    if (
      progress.policyVersion !== DATA_LIFECYCLE_POLICY_VERSION ||
      requested > current
    )
      return result("invalid-progress")
    const started = progress.purgeStartedAt
      ? timestamp(progress.purgeStartedAt)
      : null
    const checkpoints = Object.entries(progress.checkpoints)
    if (
      (started !== null && (started < recoveryEnd || started > current)) ||
      checkpoints.some(
        ([target, completed]) =>
          !deletionPurgeTargets.includes(target as DeletionPurgeTarget) ||
          started === null ||
          timestamp(completed) < started ||
          timestamp(completed) > current
      )
    )
      return result("invalid-progress")
    if (!progress.revocationRecorded) {
      return result(
        started !== null ||
          checkpoints.length ||
          progress.backupExpiryVerifiedAt
          ? "invalid-progress"
          : "revocation-required"
      )
    }
    const complete = deletionPurgeTargets.every(
      (target) => progress.checkpoints[target] !== undefined
    )
    if (progress.backupExpiryVerifiedAt && !complete)
      return result("invalid-progress")
    if (current < recoveryEnd) return result("recoverable")
    if (started === null) return result("purge-required")
    if (!complete) return result("purging")
    const onlinePurgedAt = new Date(
      Math.max(...checkpoints.map(([, completed]) => timestamp(completed)))
    )
    const backupExpiresBy = afterDays(onlinePurgedAt, BACKUP_RETENTION_DAYS)
    let phase: DeletionAssessment["phase"]
    if (progress.backupExpiryVerifiedAt) {
      const verified = timestamp(progress.backupExpiryVerifiedAt)
      if (verified < timestamp(backupExpiresBy) || verified > current)
        return result("invalid-progress")
      phase = "completed"
    } else {
      phase =
        current < timestamp(backupExpiresBy)
          ? "awaiting-backup-expiry"
          : "backup-verification-required"
    }
    return { ...result(phase), backupExpiresBy }
  } catch {
    return result("invalid-progress")
  }
}
