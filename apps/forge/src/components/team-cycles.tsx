import { Link } from "@tanstack/react-router"
import { format } from "date-fns"
import type { TeamSummary } from "@/lib/team-contract"
import { useTeamCycles } from "@/lib/team-cycles"

function TimelineIcon({
  planned = false,
  pause = false,
}: {
  planned?: boolean
  pause?: boolean
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="size-4 shrink-0 text-muted-foreground"
    >
      <circle
        cx="10"
        cy="10"
        r="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={planned ? "1 3" : undefined}
      />
      {pause ? (
        <path d="M8 7v6m4-6v6" stroke="currentColor" strokeWidth="1.5" />
      ) : (
        !planned && <path d="m8 6 6 4-6 4Z" fill="currentColor" />
      )}
    </svg>
  )
}

function CycleRow({
  team,
  number,
  start,
  end,
  issueCount,
  state,
  timezone,
}: {
  team: TeamSummary
  number: number
  start: Date
  end: Date
  issueCount: number
  state: string
  timezone: string
}) {
  return (
    <Link
      to="/teams/$teamSlug/cycle/$cycleNumber"
      params={{ teamSlug: team.slug, cycleNumber: String(number) }}
      className="group relative flex min-h-[72px] items-center gap-4 rounded-lg py-4 pr-5 pl-[112px] text-sm transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring max-sm:flex-wrap max-sm:gap-2 max-sm:pl-20"
    >
      <span className="pointer-events-none absolute bottom-0 left-[66px] z-10 size-2 -translate-x-1/2 translate-y-1/2 rounded-full border border-muted-foreground/50 bg-background max-sm:left-12" />
      <span className="absolute bottom-0 left-2 w-10 translate-y-1/2 text-right text-xs leading-tight text-muted-foreground/70 max-sm:left-0">
        {format(start, "MMM")}
        <br />
        {format(start, "d")}
      </span>
      <TimelineIcon planned={state !== "Current"} />
      <span className="font-medium">
        Cycle {number}
        <span className="mt-1 block text-xs font-normal text-muted-foreground">
          {format(start, "MMM d, yyyy")} – {format(end, "MMM d, yyyy")} ·{" "}
          {timezone}
        </span>
      </span>
      <span className="ml-auto flex items-center gap-4 text-muted-foreground max-sm:ml-0 max-sm:w-full">
        <span className="rounded bg-muted/30 px-1.5 py-0.5 text-xs">
          {state}
        </span>
        <span>{issueCount} scope</span>
      </span>
      <span className="absolute right-0 bottom-0 left-[112px] border-b border-border/50 max-sm:left-20" />
    </Link>
  )
}

export function TeamCycles({ team }: { team: TeamSummary }) {
  const {
    settings,
    ready,
    error,
    cycles: storedCycles,
  } = useTeamCycles(team.id)
  const cycles = [...storedCycles].reverse()

  return (
    <main
      aria-label="Cycles"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto overscroll-contain px-2 pb-10"
    >
      {!ready ? (
        <p role="status" className="p-6 text-sm text-muted-foreground">
          Loading cycles…
        </p>
      ) : error ? (
        <p role="alert" className="p-6 text-sm text-destructive">
          {error}
        </p>
      ) : !settings.enabled ? (
        <div className="m-auto max-w-sm text-center">
          <h1 className="font-medium">Cycles are disabled</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Enable cycles in this team’s settings to plan work in repeating
            intervals.
          </p>
          <Link
            to="/settings/teams/$teamSlug/cycles"
            params={{ teamSlug: team.slug }}
            className="mt-4 inline-block text-sm underline"
          >
            Cycle settings
          </Link>
        </div>
      ) : (
        <ol
          aria-label="Upcoming cycle schedule"
          className="relative before:absolute before:top-0 before:bottom-0 before:left-[66px] before:border-l before:border-border/60 max-sm:before:left-12"
        >
          {cycles.map((cycle) => (
            <li key={cycle.number}>
              <CycleRow team={team} {...cycle} />
            </li>
          ))}
        </ol>
      )}
    </main>
  )
}
