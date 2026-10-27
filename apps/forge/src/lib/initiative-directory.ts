import { listTeams } from "./team-state"
import { loadWorkspaceAccess } from "./member-state"

export async function loadInitiativeDirectory() {
  const [teams, members] = await Promise.allSettled([
    listTeams(),
    loadWorkspaceAccess(),
  ])
  return {
    teams: teams.status === "fulfilled" ? teams.value : [],
    people:
      members.status === "fulfilled"
        ? members.value.members.map((member) => ({
            id: member.userId,
            name: member.name,
            image: member.image,
          }))
        : [],
    error:
      teams.status === "rejected" || members.status === "rejected"
        ? "Some workspace members or teams could not be loaded. Initiatives are still available."
        : "",
  }
}
