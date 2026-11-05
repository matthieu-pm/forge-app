import type { SharedCycle } from "@/lib/team-cycles-contract"

export function CycleClosureSummary({
  cycle,
}: {
  cycle: Pick<
    SharedCycle,
    "closure" | "completedCount" | "issueCount" | "timezone"
  >
}) {
  if (!cycle.closure) return null
  const closed = new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeZone: cycle.timezone,
  }).format(new Date(cycle.closure.closedAt))
  return (
    <p
      role="status"
      className="border-b border-border/50 px-6 py-3 text-xs leading-5 text-muted-foreground"
    >
      Closed {closed}. At closure: {cycle.completedCount} of {cycle.issueCount}{" "}
      completed · {cycle.closure.carriedCount} carried forward. Issues below
      show their current details. Totals include only issues you can access.
    </p>
  )
}
