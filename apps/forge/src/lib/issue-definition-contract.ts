import { z } from "zod"
import { initialTeamStatuses, teamStatusDirectorySchema } from "./team-statuses"
import { teamLabelDirectorySchema } from "./team-labels"
import {
  branchNameError,
  initialTeamWorkflows,
  workflowsSchema,
} from "./team-workflows"

export const emptySharedLabels = () => ({
  version: 1 as const,
  labels: [],
  groups: [],
  inheritedCount: 0,
})
// An absent source allows every destination; an explicit empty list allows none.
export const transitionRulesSchema = z.record(
  z.string(),
  z.array(z.string()).max(200)
)
export type TransitionRules = z.infer<typeof transitionRulesSchema>
export const definitionValueSchema = z
  .object({
    statuses: teamStatusDirectorySchema,
    labels: teamLabelDirectorySchema,
    workflows: workflowsSchema,
    transitions: transitionRulesSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set(value.statuses.statuses.map((s) => s.id))
    const fail = (message: string) => ctx.addIssue({ code: "custom", message })
    if (
      ids.size > 200 ||
      value.labels.labels.length > 1000 ||
      value.labels.groups.length > 200
    )
      fail("Too many definitions.")
    for (const [source, targets] of Object.entries(value.transitions)) {
      if (
        !ids.has(source) ||
        targets.some((id) => !ids.has(id)) ||
        new Set(targets).size !== targets.length
      )
        fail("Transition rules must reference current statuses.")
    }
    for (const rules of [
      value.workflows.pullRequests,
      ...value.workflows.branches.map((b) => b.rules),
    ])
      if (Object.values(rules).some((id) => id && !ids.has(id)))
        fail(
          "An automation references an unavailable status. Choose a replacement first."
        )
    if (
      !value.statuses.statuses.some(
        (s) => s.id === value.workflows.staleStatus && s.group === "canceled"
      )
    )
      fail("The stale issue status must be a canceled status.")
    for (const branch of value.workflows.branches) {
      const error = branchNameError(
        branch.name,
        value.workflows.branches,
        branch.id,
        branch.useRegex
      )
      if (error) fail(error)
    }
    for (const items of [value.labels.labels, value.labels.groups]) {
      if (
        new Set(items.map((l) => l.id)).size !== items.length ||
        new Set(items.map((l) => l.name.toLowerCase())).size !== items.length
      )
        fail("Definition names and IDs must be unique within their scope.")
      if (items.some((l) => !z.uuid().safeParse(l.id).success))
        fail("Label and group IDs must be UUIDs.")
    }
    if (
      value.labels.labels.some(
        (l) => l.groupId && !value.labels.groups.some((g) => g.id === l.groupId)
      )
    )
      fail("Choose a group from this scope.")
  })
export type DefinitionValue = z.infer<typeof definitionValueSchema>
export function defaultDefinitionValue(): DefinitionValue {
  return {
    statuses: initialTeamStatuses(),
    labels: emptySharedLabels(),
    workflows: initialTeamWorkflows(),
    transitions: {},
  }
}
export const definitionSnapshotSchema = z.object({
  workspaceId: z.string(),
  teamId: z.uuid().nullable(),
  revision: z.number().int().nonnegative(),
  canManage: z.boolean(),
  value: definitionValueSchema,
})
export type DefinitionSnapshot = z.infer<typeof definitionSnapshotSchema>
export const definitionCommandSchema = z
  .object({
    workspaceId: z.string(),
    sessionId: z.string(),
    teamId: z.uuid().nullable(),
    commandKey: z.string().min(1).max(255),
    expectedRevision: z.number().int().nonnegative(),
    value: definitionValueSchema,
    statusReplacements: z.record(z.string(), z.string()).default({}),
    labelReplacements: z.record(z.uuid(), z.uuid()).default({}),
  })
  .strict()
export type DefinitionCommand = z.infer<typeof definitionCommandSchema>
export function canTransition(
  rules: TransitionRules,
  from: string,
  to: string
) {
  return from === to || !Object.hasOwn(rules, from) || rules[from].includes(to)
}
