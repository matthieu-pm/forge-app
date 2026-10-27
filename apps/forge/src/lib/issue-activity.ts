import type { IssueFilter, TeamIssue } from "./team-issues"

type Update = TeamIssue["activity"][number]
type Comment = TeamIssue["comments"][number]
export type ActivityReferenceKind = "member" | "project" | "label"
export type ActivitySegment =
  { text: string } | { kind: ActivityReferenceKind; value: string }
export type ActivitySearch = {
  project?: string
  label?: string
  assignee?: string
}

export function readActivitySearch(
  search: Record<string, unknown>
): ActivitySearch {
  for (const key of ["project", "label", "assignee"] as const) {
    const value = search[key]
    if (typeof value === "string" && value.trim() && value.length <= 200)
      return { [key]: value.trim() }
  }
  return {}
}
export function activityContextFilter(
  search: ActivitySearch
): IssueFilter | undefined {
  const [key, value] = Object.entries(readActivitySearch(search))[0] ?? []
  if (!value) return undefined
  return {
    id: "activity-context",
    field:
      key === "label" ? "labels" : key === "project" ? "project" : "assignee",
    operator: "is",
    value,
  }
}
export function activityReferenceSearch(
  kind: ActivityReferenceKind,
  value: string
) {
  return {
    view: "all",
    ...readActivitySearch({ [kind === "member" ? "assignee" : kind]: value }),
  }
}
export function activityReferenceIssues(
  issues: Array<TeamIssue>,
  kind: ActivityReferenceKind,
  value: string
) {
  const expected = value.toLocaleLowerCase()
  return issues.filter((issue) =>
    kind === "label"
      ? (issue.labels ?? "")
          .split(",")
          .some((label) => label.trim().toLocaleLowerCase() === expected)
      : (kind === "member"
          ? issue.assignee
          : issue.project
        )?.toLocaleLowerCase() === expected
  )
}
export function activitySegments(
  event: Update,
  userId: string
): Array<ActivitySegment> {
  const text = (value: string): ActivitySegment => ({ text: value })
  const ref = (
    kind: ActivityReferenceKind,
    value: string
  ): ActivitySegment => ({ kind, value })
  if (event.to === undefined) return [text(event.text)]
  if (event.field === "assignee")
    return !event.to
      ? [text("unassigned the issue")]
      : event.to === event.author ||
          (event.author === "You" && event.to === userId)
        ? [text("self-assigned the issue")]
        : [text("assigned the issue to "), ref("member", event.to)]
  if (event.field === "priority")
    return [
      text(
        event.to === "No priority"
          ? "removed the priority"
          : `set priority to ${event.to}`
      ),
    ]
  if (event.field === "project")
    return [
      text(event.to ? "added to project " : "removed from project "),
      ref("project", event.to || event.from || ""),
    ]
  if (event.field === "labels") {
    const split = (value = "") =>
      value
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean)
    const before = split(event.from),
      after = split(event.to)
    const added = after.filter((label) => !before.includes(label)),
      removed = before.filter((label) => !after.includes(label))
    const segments: Array<ActivitySegment> = []
    for (const [verb, labels] of [
      ["added", added],
      ["removed", removed],
    ] as const) {
      if (!labels.length) continue
      if (segments.length) segments.push(text(" and "))
      segments.push(
        text(`${verb} ${labels.length === 1 ? "label" : "labels"} `)
      )
      labels.forEach((label, index) => {
        if (index) segments.push(text(", "))
        segments.push(ref("label", label))
      })
    }
    return segments
  }
  return [text(event.text)]
}
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
