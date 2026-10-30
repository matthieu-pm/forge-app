import { z } from "zod"

export const issueFields = {
  status: "Status",
  assignee: "Assignee",
  agent: "Agent",
  agentSession: "Agent Session",
  creator: "Creator",
  priority: "Priority",
  labels: "Labels",
  parentId: "Relations",
  suggestedLabel: "Suggested label",
  dueDate: "Due date",
  createdAt: "Created",
  updatedAt: "Updated",
  project: "Project",
  milestone: "Project properties",
  subscribers: "Subscribers",
  autoClosed: "Auto-closed",
  content: "Content",
  links: "Links",
  templateName: "Template",
} as const
export type IssueField = keyof typeof issueFields
const filterSchema = z.object({
  id: z.string(),
  field: z.enum(Object.keys(issueFields) as [IssueField, ...Array<IssueField>]),
  operator: z.enum([
    "is",
    "isNot",
    "contains",
    "notContains",
    "set",
    "notSet",
    "before",
    "after",
  ]),
  value: z.string(),
})
export type IssueFilter = z.infer<typeof filterSchema>
export const filtersSchema = z.object({
  match: z.enum(["all", "any"]),
  rules: z.array(filterSchema),
})
export type IssueFilters = z.infer<typeof filtersSchema>
export const emptyIssueFilters = (): IssueFilters => ({
  match: "all",
  rules: [],
})
const groupSchema = z.enum([
  "Status",
  "Priority",
  "Assignee",
  "Project",
  "Labels",
  "No grouping",
])
export const displaySchema = z.object({
  layout: z.enum(["list", "board"]),
  group: groupSchema,
  subgroup: groupSchema,
  order: z.enum([
    "Priority",
    "Created",
    "Updated",
    "Due date",
    "Title",
    "Status",
  ]),
  descending: z.boolean(),
  groupDescending: z.boolean(),
  completedByRecency: z.boolean(),
  showSubIssues: z.boolean(),
  nested: z.enum(["Show matching", "Show all", "Hide"]),
  showEmpty: z.boolean(),
  properties: z.array(z.string()),
  showPullRequests: z.boolean().optional(),
})
export type IssueDisplay = z.infer<typeof displaySchema>
export const defaultIssueDisplay = (): IssueDisplay => ({
  layout: "list",
  group: "Status",
  subgroup: "No grouping",
  order: "Priority",
  descending: false,
  groupDescending: false,
  completedByRecency: false,
  showSubIssues: true,
  nested: "Show matching",
  showEmpty: false,
  properties: [
    "ID",
    "Status",
    "Assignee",
    "Priority",
    "Project",
    "Due date",
    "Labels",
    "Created",
  ],
})
