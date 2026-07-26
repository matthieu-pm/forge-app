export const TEAM_LIST_CHANGED_EVENT = "forge:team-list-changed"

export function notifyTeamDirectoryChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(TEAM_LIST_CHANGED_EVENT))
  }
}
