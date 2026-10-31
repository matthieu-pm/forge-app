import { z } from "zod"
import {
  defaultIssueDisplay,
  displaySchema,
  emptyIssueFilters,
  filtersSchema,
} from "./issue-view-contract"
import type { CanonicalSnapshot } from "./canonical-issue-cache"

// Bounds apply to every transport, including future API/MCP callers.
export const issueQuerySchema = z
  .object({
    teamIds: z.array(z.uuid()).max(100).optional(),
    project: z.string().max(240).optional(),
    milestone: z.array(z.string().max(240)).max(30).optional(),
    cycle: z.string().max(36).optional(),
    triage: z.boolean().optional(),
    showSnoozed: z.boolean().default(false),
    personal: z
      .enum(["assigned", "created", "subscribed", "activity"])
      .optional(),
    scope: z.enum(["all", "active", "backlog"]).default("all"),
    search: z.string().trim().max(200).default(""),
    filters: filtersSchema
      .extend({
        rules: filtersSchema.shape.rules
          .max(20)
          .refine((r) =>
            r.every((v) => v.value.length <= 500 && v.id.length <= 200)
          ),
      })
      .default(emptyIssueFilters),
    display: displaySchema
      .extend({ properties: z.array(z.string().max(100)).max(30) })
      .default(defaultIssueDisplay),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().max(4096).optional(),
  })
  .strict()
export type IssueQuery = z.input<typeof issueQuerySchema>
export type ParsedIssueQuery = z.output<typeof issueQuerySchema>
export type IssueFacet =
  "assignee" | "labels" | "priority" | "project" | "team" | "status"
export type IssueQueryPage = {
  workspaceId: string
  userId: string
  sessionId: string
  records: CanonicalSnapshot["records"]
  resultRevision: string
  projectTotals: Array<{ project: string; count: number; completed: number }>
  rollups: Array<{
    project: string
    milestone: string
    count: number
    completed: number
  }>
  nextCursor: string | null
  total: number
  facets: Record<IssueFacet, Array<{ value: string; count: number }>>
  facetsTruncated: boolean
  groups: Array<{ group: string; subgroup: string; count: number }>
}
export const browserIssueQuerySchema = z
  .object({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    query: issueQuerySchema,
  })
  .strict()
