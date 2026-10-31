import {
  canonicalIssueEpoch,
  canonicalIssueState,
  mergeCanonicalIssueRecords,
} from "./canonical-issue-cache"
import { persistIssueEngagement } from "./issue-engagement-state"
import { productStorage, saveProductValue } from "./product-storage"
import { issueEngagementCommandSchema } from "./issue-engagement-contract"
import type { CanonicalSnapshot } from "./canonical-issue-cache"
import type { IssueEngagementCommand } from "./issue-engagement-contract"

export const engagementDraftKey = (issueId: string) =>
  `forge:issue-engagement-draft:v1:${issueId}`
export function pendingIssueEngagement(issueId: string) {
  const raw = productStorage.getItem(engagementDraftKey(issueId))
  if (!raw) return null
  const value = JSON.parse(raw)
  const command = issueEngagementCommandSchema.parse(value.command)
  if (command.issueId !== issueId)
    throw new Error("Invalid saved discussion change.")
  return command
}
export async function sendIssueEngagement(input: IssueEngagementCommand) {
  const identity = canonicalIssueState(),
    epoch = canonicalIssueEpoch()
  if (!identity) throw new Error("Reload before changing this issue.")
  const key = engagementDraftKey(input.issueId)
  await saveProductValue(
    key,
    JSON.stringify({ issueId: input.issueId, command: input })
  )
  if (epoch !== canonicalIssueEpoch())
    throw new Error("The active session changed.")
  const result = JSON.parse(
    await persistIssueEngagement({
      data: {
        workspaceId: identity.workspaceId,
        sessionId: identity.sessionId,
        command: input,
      },
    })
  ) as {
    status: "saved" | "rejected"
    message?: string
    records: CanonicalSnapshot["records"]
  }
  if (epoch !== canonicalIssueEpoch())
    throw new Error("The active session changed.")
  mergeCanonicalIssueRecords(result.records)
  await saveProductValue(key, null)
  return result
}
