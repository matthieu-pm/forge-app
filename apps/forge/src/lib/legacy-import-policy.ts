/** FOR-22 pure decision contract. Import adapters own validation, live authorization,
 * durable receipts and atomic writes; this module performs no storage or uploads. */
export const LEGACY_IMPORT_POLICY_VERSION = 1

export type LegacyImportDestination =
  | { kind: "account"; userId: string }
  | { kind: "workspace"; workspaceId: string; teamId?: string }

type ReviewedSelection = {
  policyVersion: number
  actorId: string
  destination: LegacyImportDestination
  sourceFingerprint: string
  /** Covers selected records/fields, mappings, exclusions and conflict choices. */
  selectionFingerprint: string
}

export type LegacyImportReview = ReviewedSelection & {
  sourceStatus: "supported" | "malformed" | "unsupported"
  /** An account hint from a personal store; never evidence of ownership. */
  sourceAccountHint?: string
  /** Derived from current trusted authorization, never from a browser payload. */
  canWriteDestination: boolean
  backupVerified: boolean
  confirmation?: ReviewedSelection & { ownershipConfirmed: boolean }
}

function sameDestination(
  left: LegacyImportDestination,
  right: LegacyImportDestination
) {
  if (left.kind === "account" && right.kind === "account")
    return left.userId === right.userId
  return (
    left.kind === "workspace" &&
    right.kind === "workspace" &&
    left.workspaceId === right.workspaceId &&
    left.teamId === right.teamId
  )
}

/** Run for each independently selected source group, including on resume. */
export function evaluateLegacyImportReview(review: LegacyImportReview) {
  if (review.policyVersion !== LEGACY_IMPORT_POLICY_VERSION)
    return "review-required" as const
  if (
    !review.actorId.trim() ||
    !review.canWriteDestination ||
    (review.destination.kind === "account"
      ? review.destination.userId !== review.actorId
      : !review.destination.workspaceId.trim() ||
        (review.destination.teamId !== undefined &&
          !review.destination.teamId.trim()))
  )
    return "destination-denied" as const
  if (
    review.sourceAccountHint !== undefined &&
    review.sourceAccountHint !== review.actorId
  )
    return "other-account-excluded" as const
  if (review.sourceStatus !== "supported") return "preserve-source" as const
  if (!review.backupVerified) return "backup-required" as const
  if (!review.sourceFingerprint.trim() || !review.selectionFingerprint.trim())
    return "review-required" as const
  const confirmed = review.confirmation
  if (!confirmed?.ownershipConfirmed) return "review-required" as const
  if (
    confirmed.policyVersion !== review.policyVersion ||
    confirmed.actorId !== review.actorId ||
    !sameDestination(confirmed.destination, review.destination) ||
    confirmed.sourceFingerprint !== review.sourceFingerprint ||
    confirmed.selectionFingerprint !== review.selectionFingerprint
  )
    return "review-required" as const
  return "ready" as const
}

export type LegacyConflictChoice =
  | { kind: "keep-server" }
  | { kind: "keep-both" }
  | { kind: "use-local"; expectedVersion: string }

export type LegacyConflict = {
  kind: "content" | "preference-field"
  sourceChecksum: string
  target: { checksum: string; version: string } | null
  /** A server-verified alias/receipt in this destination, not title matching. */
  receipt?: { sourceChecksum: string; targetChecksum: string }
  choice?: LegacyConflictChoice
}

export type LegacyConflictDecision =
  | { action: "create" | "create-copy" | "skip" | "already-imported" }
  | { action: "create-field"; expectedAbsent: true }
  | { action: "choice-required" | "review-required" }
  | { action: "patch-field"; expectedVersion: string }

/** Does not authorize a write. Workspace content has no overwrite outcome. */
export function resolveLegacyImportConflict(
  conflict: LegacyConflict
): LegacyConflictDecision {
  const { target, receipt, choice } = conflict
  if (!conflict.sourceChecksum.trim()) return { action: "review-required" }
  if (choice?.kind === "keep-server") return { action: "skip" }
  if (
    target &&
    receipt?.sourceChecksum === conflict.sourceChecksum &&
    receipt.targetChecksum === target.checksum
  )
    return { action: "already-imported" }
  // A missing receipt target may have been deleted. Never resurrect it silently.
  if (!target && !receipt && !choice)
    return conflict.kind === "preference-field"
      ? { action: "create-field", expectedAbsent: true }
      : { action: "create" }
  if (!choice) return { action: "choice-required" }
  if (choice.kind === "keep-both")
    return conflict.kind === "content"
      ? { action: "create-copy" }
      : { action: "choice-required" }
  if (
    conflict.kind !== "preference-field" ||
    !target ||
    !choice.expectedVersion.trim() ||
    target.version !== choice.expectedVersion
  )
    return { action: "review-required" }
  return { action: "patch-field", expectedVersion: choice.expectedVersion }
}
