import { listTeams, loadTeamDirectory } from "./team-state"
import { loadWorkspaceAccess } from "./member-state"

export async function loadInitiativeDirectory() {
  const [teams, members, directory] = await Promise.allSettled([
    listTeams(),
    loadWorkspaceAccess(),
    loadTeamDirectory({ data: "active" }),
  ])
  return {
    teams: teams.status === "fulfilled" ? teams.value : [],
    people:
      members.status === "fulfilled"
        ? members.value.members.map((member) => ({
            id: member.userId,
            name: member.name,
            image: member.image,
            username:
              member.username ??
              (directory.status === "fulfilled"
                ? directory.value.items
                    .flatMap(
                      (team) => team.directoryMembers ?? team.memberPreviews
                    )
                    .find((person) => person.id === member.userId)?.username
                : undefined),
            isOnline: member.isOnline,
            teams:
              directory.status === "fulfilled"
                ? directory.value.items
                    .filter((team) =>
                      (team.directoryMembers ?? team.memberPreviews).some(
                        (person) => person.id === member.userId
                      )
                    )
                    .map(({ id, slug, name, icon }) => ({
                      id,
                      slug,
                      name,
                      icon,
                    }))
                : [],
          }))
        : [],
    error:
      teams.status === "rejected" || members.status === "rejected"
        ? "Some workspace members or teams could not be loaded. Initiatives are still available."
        : "",
  }
}
