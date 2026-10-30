import type { DefinitionSnapshot } from "./issue-definition-contract"

export const DEFINITIONS_CHANGED = "forge:issue-definitions-changed"
let snapshots = new Map<string, DefinitionSnapshot>()
let active = false
export function replaceDefinitionCache(
  values: Array<DefinitionSnapshot>,
  enabled = true
) {
  snapshots = new Map(values.map((v) => [v.teamId ?? "workspace", v]))
  active = enabled
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(DEFINITIONS_CHANGED))
}
export function sharedDefinitionsActive() {
  return active
}
export function cachedDefinitions(teamId: string | null) {
  const snapshot = snapshots.get(teamId ?? "workspace")
  if (!snapshot)
    throw new Error(
      "Shared issue definitions are unavailable. Reload to try again."
    )
  return snapshot
}
export function sharedIssueLabels(teamId: string | null) {
  const local = cachedDefinitions(teamId).value.labels
  const shared = teamId ? cachedDefinitions(null).value.labels : null
  return {
    ...local,
    labels: [...local.labels, ...(shared?.labels ?? [])],
    groups: [...local.groups, ...(shared?.groups ?? [])],
  }
}
