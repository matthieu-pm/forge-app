import { z } from "zod"
import { teamResourceCommandSchema } from "./team-resources-contract"

const pendingSchema = z
  .object({ key: z.uuid(), command: teamResourceCommandSchema })
  .strict()
export type PendingTeamResources = z.infer<typeof pendingSchema>
type Owner = { workspaceId: string; userId: string }
function prefix(owner: Owner, teamId: string) {
  return (
    JSON.stringify([
      "forge.team-resources",
      1,
      owner.workspaceId,
      owner.userId,
      teamId,
    ]).slice(0, -1) + ","
  )
}
function recordKey(owner: Owner, pending: PendingTeamResources) {
  return (
    prefix(owner, pending.command.teamId) + JSON.stringify(pending.key) + "]"
  )
}
export function recoveredTeamResources(owner: Owner, teamId: string) {
  const key = Array.from({ length: localStorage.length }, (_, i) =>
    localStorage.key(i)
  )
    .filter((k): k is string => Boolean(k?.startsWith(prefix(owner, teamId))))
    .sort()[0]
  if (!key) return null
  const pending = pendingSchema.parse(
    JSON.parse(localStorage.getItem(key) ?? "null")
  )
  if (pending.command.teamId !== teamId || key !== recordKey(owner, pending))
    throw new Error(
      "The saved resource request cannot be verified. Its recovery record is preserved."
    )
  return pending
}
export function retainTeamResources(
  owner: Owner,
  pending: PendingTeamResources
) {
  pendingSchema.parse(pending)
  localStorage.setItem(recordKey(owner, pending), JSON.stringify(pending))
}
export function retireTeamResources(
  owner: Owner,
  pending: PendingTeamResources
) {
  const key = recordKey(owner, pending)
  if (localStorage.getItem(key) === JSON.stringify(pending))
    localStorage.removeItem(key)
}
