import type { InboxUpdate } from "@/lib/inbox-state"

export const scope = { workspaceId: "inbox-test-workspace", userId: "me" }
export function update(overrides: Partial<InboxUpdate> = {}): InboxUpdate {
  return {
    id: "event-1",
    workspaceId: scope.workspaceId,
    actor: "Alex Morgan",
    actorId: "alex",
    kind: "assignment",
    createdAt: "2026-10-23T10:00:00.000Z",
    message: "Ready for your review.",
    recipientIds: ["me"],
    subscriberIds: ["me"],
    issue: {
      id: "issue-1",
      identifier: "FOR-42",
      title: "Make onboarding feel effortless",
      description: "Help new teams find their first useful action.",
      status: "In progress",
      priority: "High",
      assignee: "You",
      project: "Getting started",
    },
    ...overrides,
  }
}
