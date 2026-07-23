import type { TeamSummary } from "@/lib/team-contract"

type TeamRouteMatch = {
  context?: unknown
  loaderData?: unknown
}

function readTeam(value: unknown) {
  if (!value || typeof value !== "object" || !("team" in value)) {
    return undefined
  }

  return (value as { team?: TeamSummary }).team
}

export function getTeamFromRouteMatches(
  matches: ReadonlyArray<TeamRouteMatch>
) {
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]
    const team = readTeam(match.loaderData) ?? readTeam(match.context)
    if (team) return team
  }

  return undefined
}
