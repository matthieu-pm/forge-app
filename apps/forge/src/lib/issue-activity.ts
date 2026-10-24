import type { TeamIssue } from "./team-issues"

type Update = TeamIssue["activity"][number]
type Comment = TeamIssue["comments"][number]
export type ActivityEntry =
  | { kind: "comment"; id: string; createdAt: string; comment: Comment }
  | { kind: "updates"; id: string; createdAt: string; events: Array<Update> }

// Group nearby property changes, but never across a comment in the timeline.
export function issueActivityTimeline(
  issue: Pick<TeamIssue, "activity" | "comments">
) {
  const entries: Array<ActivityEntry> = [
    ...issue.activity.map((event): ActivityEntry => ({
      kind: "updates",
      id: event.id,
      createdAt: event.createdAt,
      events: [event],
    })),
    ...issue.comments
      .filter((comment) => !comment.parentId)
      .map((comment): ActivityEntry => ({
        kind: "comment",
        id: comment.id,
        createdAt: comment.createdAt,
        comment,
      })),
  ]
  entries.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  return entries.reduce<Array<ActivityEntry>>((timeline, entry) => {
    const last = timeline.at(-1)
    if (
      entry.kind === "updates" &&
      last?.kind === "updates" &&
      last.events[0].author === entry.events[0].author &&
      Date.parse(entry.createdAt) - Date.parse(last.createdAt) <= 60_000
    ) {
      last.events.push(...entry.events)
    } else timeline.push(entry)
    return timeline
  }, [])
}
