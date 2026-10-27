import type { CallAction, CallRecord } from "@/lib/calls"
import {
  blankIssueDraft,
  getIssueStatuses,
  readIssueStore,
  saveTeamIssue,
} from "@/lib/team-issues"

export function callActionSource(
  callId: string,
  actionId: string,
  origin: string
) {
  return new URL(
    `/workspace/calls?call=${encodeURIComponent(callId)}#action-${encodeURIComponent(actionId)}`,
    origin
  ).href
}
export function findCallIssue(
  call: CallRecord,
  action: CallAction,
  origin: string
) {
  const source = callActionSource(call.id, action.id, origin)
  return readIssueStore(call.teamId).issues.find((issue) =>
    issue.links.some((link) => link.url === source)
  )
}
export function createCallIssue(
  call: CallRecord,
  action: CallAction,
  origin: string,
  creator: string
) {
  const existing = findCallIssue(call, action, origin)
  if (existing) return existing
  const statuses = getIssueStatuses(call.teamId)
  const status =
    statuses.find((item) => item.group === "unstarted") ??
    statuses.find((item) => item.group === "backlog")
  if (!status)
    throw new Error(
      "Add an open status to this team’s workflow before creating an issue."
    )
  const source = callActionSource(call.id, action.id, origin)
  return saveTeamIssue(
    call.teamId,
    {
      ...blankIssueDraft(status.id),
      title: action.title,
      description: `Follow-up from ${call.title}.${action.owner ? `\nMentioned owner: ${action.owner}` : ""}\n\nCall: ${source}`,
      links: [{ title: call.title, url: source }],
    },
    { creator }
  )
}
