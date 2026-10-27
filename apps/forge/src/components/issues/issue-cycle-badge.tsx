import { Link } from "@tanstack/react-router"
import { format, isValid, parseISO } from "date-fns"
import { scheduledTeamCycles, useTeamCycles } from "@/lib/team-cycles"

export function IssueCycleBadge({
  team,
  value,
}: {
  team: { id: string; slug: string }
  value: string
}) {
  const { settings, ready, error } = useTeamCycles(team.id)
  if (!ready || error || !settings.enabled || !value) return null

  const cycle = scheduledTeamCycles(settings).find(
    (item) => item.value === value
  )
  const date = parseISO(value)
  const label = cycle
    ? `Cycle ${cycle.number} · ${format(cycle.start, "MMM d")}–${format(cycle.end, "MMM d, yyyy")}`
    : isValid(date)
      ? `Cycle starting ${format(date, "MMM d, yyyy")}`
      : "Assigned cycle"
  const destination = cycle
    ? {
        to: "/teams/$teamSlug/cycle/$cycleNumber" as const,
        params: { teamSlug: team.slug, cycleNumber: String(cycle.number) },
      }
    : {
        to: "/teams/$teamSlug/cycles" as const,
        params: { teamSlug: team.slug },
      }

  return (
    <Link
      {...destination}
      aria-label={cycle ? `Open Cycle ${cycle.number}` : label}
      title={label}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-border/50 px-2 text-xs text-muted-foreground tabular-nums outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        aria-hidden="true"
        className="size-3.5 shrink-0"
      >
        <circle cx="8" cy="8" r="6" />
        <path d="m6.5 5.5 4 2.5-4 2.5z" strokeLinejoin="round" />
      </svg>
      <span>
        {cycle ? cycle.number : isValid(date) ? format(date, "MMM d") : "Cycle"}
      </span>
    </Link>
  )
}
