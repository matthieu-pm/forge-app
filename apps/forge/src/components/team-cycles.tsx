import { Link } from "@tanstack/react-router"
import { addWeeks, format } from "date-fns"
import { Clock05Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import type { TeamSummary } from "@/lib/team-contract"
import { nextCycleStart, useTeamCycles } from "@/lib/team-cycles"

export function TeamCycles({ team }: { team: TeamSummary }) {
  const { settings, ready, error } = useTeamCycles(team.id)
  const firstStart = nextCycleStart(settings.startDay)
  const cycles = Array.from({ length: settings.futureCycles }, (_, index) => {
    const start = addWeeks(
      firstStart,
      index * (settings.duration + settings.cooldown)
    )
    const end = addWeeks(start, settings.duration)
    end.setDate(end.getDate() - 1)
    return { number: index + 1, start, end }
  }).reverse()

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-auto p-6 sm:p-10">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-medium">Cycles</h1>
          {ready && !error && settings.enabled && (
            <p className="mt-1 text-sm text-muted-foreground">
              Preview your team’s upcoming cycle schedule.
            </p>
          )}
        </div>
        <Link
          to="/settings/teams/$teamSlug/cycles"
          params={{ teamSlug: team.slug }}
          className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          Cycle settings
        </Link>
      </div>
      {!ready ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading cycles…
        </p>
      ) : error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : !settings.enabled ? (
        <div className="m-auto max-w-sm text-center">
          <HugeiconsIcon
            icon={Clock05Icon}
            className="mx-auto mb-4 size-8 text-muted-foreground"
          />
          <h2 className="font-medium">Cycles are disabled</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Enable cycles in this team’s settings to plan work in repeating
            intervals.
          </p>
        </div>
      ) : (
        <ol
          aria-label="Upcoming cycle schedule"
          className="ml-2 border-l border-border/60"
        >
          {cycles.map((cycle, index) => (
            <li key={cycle.number} className="relative pl-6 sm:pl-10">
              <span className="absolute top-8 -left-1 size-2 rounded-full border border-muted-foreground bg-background" />
              <div className="flex min-h-20 flex-wrap items-center justify-between gap-4 border-b border-border/50 py-4 text-sm">
                <div className="flex items-center gap-4">
                  <HugeiconsIcon
                    icon={Clock05Icon}
                    className="size-4 text-muted-foreground"
                  />
                  <span className="font-medium">Cycle {cycle.number}</span>
                </div>
                <div className="flex flex-wrap items-center gap-4 text-muted-foreground">
                  <span>
                    {format(cycle.start, "MMM d")} –{" "}
                    {format(cycle.end, "MMM d, yyyy")}
                  </span>
                  <span className="rounded bg-muted/40 px-2 py-0.5">
                    {cycle.number === 1 ? "Upcoming" : "Planned"}
                  </span>
                </div>
              </div>
              {settings.cooldown > 0 && index < cycles.length - 1 && (
                <p className="border-b border-border/50 py-4 text-sm text-muted-foreground/60">
                  {settings.cooldown}{" "}
                  {settings.cooldown === 1 ? "week" : "weeks"} cooldown
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </main>
  )
}
