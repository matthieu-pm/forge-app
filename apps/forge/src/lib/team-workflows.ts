import { z } from "zod"

export const pullRequestEvents = [
  { id: "draft", label: "On draft PR open, move to..." },
  { id: "open", label: "On PR open, move to..." },
  { id: "review", label: "On PR review request or activity, move to..." },
  { id: "ready", label: "On PR ready for merge, move to..." },
  { id: "merge", label: "On PR merge, move to..." },
] as const
export type PullRequestEvent = (typeof pullRequestEvents)[number]["id"]
const rulesSchema = z.object({
  draft: z.string(),
  open: z.string(),
  review: z.string(),
  ready: z.string(),
  merge: z.string(),
})
export type PullRequestRules = z.infer<typeof rulesSchema>
export const workflowDurations = ["1", "3", "6", "9", "12"] as const
const durationSchema = z.enum(workflowDurations)
const branchSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  rules: rulesSchema,
  useRegex: z.boolean().default(false),
})
export type BranchWorkflow = z.infer<typeof branchSchema>
const workflowsSchema = z.object({
  pullRequests: rulesSchema,
  branches: z
    .array(branchSchema)
    .refine(
      (branches) =>
        new Set(branches.map((b) => JSON.stringify([b.name, b.useRegex])))
          .size === branches.length &&
        new Set(branches.map((b) => b.id)).size === branches.length
    ),
  closeParents: z.boolean(),
  closeChildren: z.boolean(),
  closeStale: z.boolean(),
  staleMonths: durationSchema,
  staleStatus: z.string().min(1),
  archiveMonths: z.enum(["never", ...workflowDurations]),
  issueOrder: z.enum(["first", "last", "none"]),
})
export type TeamWorkflows = z.infer<typeof workflowsSchema>
export const teamWorkflowsStorageKey = (teamId: string) =>
  `forge:team-workflows:v1:${teamId}`
export const parseTeamWorkflows = (raw: string) =>
  workflowsSchema.parse(JSON.parse(raw))
export function initialTeamWorkflows(): TeamWorkflows {
  return {
    pullRequests: {
      draft: "",
      open: "in-progress",
      review: "in-review",
      ready: "",
      merge: "done",
    },
    branches: [],
    closeParents: false,
    closeChildren: false,
    closeStale: true,
    staleMonths: "6",
    staleStatus: "canceled",
    archiveMonths: "6",
    issueOrder: "first",
  }
}
export function branchNameError(
  name: string,
  branches: Array<BranchWorkflow>,
  editingId?: string,
  useRegex = false
) {
  if (!name.trim()) return "Enter a branch pattern."
  if (name.length > 200) return "Keep the branch pattern under 200 characters."
  if (useRegex) {
    try {
      new RegExp(name)
    } catch {
      return "Enter a valid regular expression."
    }
  }
  if (
    !useRegex &&
    (name.length > 200 ||
      /[\s~^:?*[\\]/.test(name) ||
      name.includes("..") ||
      name.includes("@{") ||
      name.includes("//") ||
      name.startsWith("/") ||
      name.endsWith("/") ||
      name.endsWith(".") ||
      name.endsWith(".lock"))
  )
    return "Enter a valid branch name, such as main or release/next."
  if (
    branches.some(
      (branch) =>
        branch.id !== editingId &&
        branch.name === name.trim() &&
        branch.useRegex === useRegex
    )
  )
    return "Rules already exist for this branch."
}
