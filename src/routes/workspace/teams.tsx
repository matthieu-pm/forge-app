import { Link, createFileRoute } from "@tanstack/react-router"
import { Add01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { protectedRouteBeforeLoad } from "@/lib/auth-state"
import { listTeams } from "@/lib/team-state"

export const Route = createFileRoute("/workspace/teams")({
  beforeLoad: protectedRouteBeforeLoad,
  loader: () => listTeams(),
  component: TeamsPage,
})

function teamInitials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

function TeamsPage() {
  const teams = Route.useLoaderData()

  return (
    <main className="flex flex-1 flex-col gap-6 px-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Teams</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage the teams and issue identifiers in this workspace.
          </p>
        </div>
        <Button size="sm" render={<Link to="/settings/teams/new" />}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          Create team
        </Button>
      </div>

      {teams.length ? (
        <div className="overflow-hidden rounded-xl border border-border/70">
          {teams.map((team, index) => (
            <Link
              key={team.id}
              to="/teams/$teamSlug/projects"
              params={{ teamSlug: team.slug }}
              className="flex items-center gap-3 bg-background px-4 py-3 transition-colors hover:bg-muted/50"
              style={
                index ? { borderTop: "1px solid var(--border)" } : undefined
              }
            >
              <Avatar className="size-8 rounded-lg after:rounded-lg">
                <AvatarFallback
                  className="rounded-lg text-xs font-semibold"
                  style={{ color: team.icon.color }}
                >
                  {team.icon.kind === "emoji"
                    ? team.icon.value
                    : teamInitials(team.name)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{team.name}</p>
                <p className="text-xs text-muted-foreground">
                  {team.identifier} · {team.timezone}
                </p>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-border/70 p-10 text-center">
          <h2 className="text-sm font-semibold">No teams yet</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Create the first team to organize issues, projects, and views.
          </p>
        </div>
      )}
    </main>
  )
}
