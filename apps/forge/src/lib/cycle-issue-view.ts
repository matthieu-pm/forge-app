import type { WorkspaceViewValues } from "./workspace-preference-contract"
import { useWorkspaceView } from "@/components/account-preference-provider"

export const cycleIssueViewKey = (teamId: string, cycle: string) =>
  `forge:cycle-issue-view:v1:${teamId}:${cycle}`
export function useCycleIssueView(teamId: string, cycle: string) {
  const sync = useWorkspaceView("cycles", JSON.stringify([teamId, cycle]))
  return {
    value: sync.value,
    error: sync.error,
    save: (patch: Partial<WorkspaceViewValues<"cycles">>) =>
      sync.save({ ...sync.value, ...patch }),
  }
}
