import {
  canonicalIssueEpoch,
  canonicalIssueState,
  mergeCanonicalIssueRecords,
} from "./canonical-issue-cache"
import { persistIssueComment } from "./issue-comment-state"
import { saveProductValue } from "./product-storage"
import type { CanonicalSnapshot } from "./canonical-issue-cache"
import type { IssueCommentCommand } from "./issue-comment-contract"

export const commentDraftKey = (issueId: string, slot: string) =>
  `forge:comment-draft:v1:${issueId}:${slot}`
export async function sendIssueComment(
  input: IssueCommentCommand,
  key: string,
  draft: Record<string, unknown>
) {
  const identity = canonicalIssueState(),
    epoch = canonicalIssueEpoch()
  if (!identity) throw new Error("Reload before commenting.")
  // Write the exact retry identity BEFORE publication. Uncertain outcomes must
  // replay this identity even after a reload, never create a second comment.
  await saveProductValue(
    key,
    JSON.stringify({ ...draft, issueId: input.issueId, command: input })
  )
  if (epoch !== canonicalIssueEpoch())
    throw new Error("The active session changed.")
  const result = JSON.parse(
    await persistIssueComment({
      data: {
        ...input,
        workspaceId: identity.workspaceId,
        sessionId: identity.sessionId,
      },
    })
  ) as {
    status: "saved" | "conflict" | "rejected"
    message?: string
    records: CanonicalSnapshot["records"]
  }
  if (epoch !== canonicalIssueEpoch())
    throw new Error("The active session changed.")
  mergeCanonicalIssueRecords(result.records)
  if (result.status === "saved") await saveProductValue(key, null)
  else
    await saveProductValue(
      key,
      JSON.stringify({
        ...draft,
        issueId: input.issueId,
        requiresReview: result.status === "conflict",
      })
    )
  return result
}
