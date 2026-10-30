import { z } from "zod"

export const projectProperties = [
  "ID",
  "Milestones",
  "Summary",
  "Priority",
  "Status",
  "Health",
  "Teams",
  "Initiatives",
  "Lead",
  "Members",
  "Dependencies",
  "Start date",
  "Target date",
  "Issues",
  "Created",
  "Updated",
  "Labels",
] as const
export const projectGroupings = [
  "No grouping",
  "Status",
  "Priority",
  "Health",
  "Teams",
  "Initiatives",
  "Lead",
] as const
export const projectOrderings = [
  "Manual",
  "Name",
  "Priority",
  "Status",
  "Health",
  "Target date",
  "Created",
  "Updated",
] as const
export const projectFilterFields = [
  "Status",
  "Priority",
  "Labels",
  "Teams",
  "Lead",
  "Members",
  "Health",
  "Target date",
  "Initiatives",
  "Title & summary",
  "Specific project",
] as const
export const projectFilterSchema = z.object({
  field: z.enum(projectFilterFields),
  value: z.string(),
})
export type ProjectFilter = z.infer<typeof projectFilterSchema>
export const projectPreferencesSchema = z.object({
  layout: z.enum(["List", "Board", "Timeline"]),
  grouping: z.enum(projectGroupings),
  ordering: z.enum(projectOrderings),
  descending: z.boolean(),
  closed: z.enum(["All", "Hide", "Only"]),
  properties: z.array(z.enum(projectProperties)),
  sidebar: z.boolean(),
  favoriteIds: z.array(z.string()).default([]),
  subscribedIds: z.array(z.string()).default([]),
  detailSidebar: z.boolean().default(false),
  sidebarTab: z.enum(["Health", "Initiatives", "Teams", "Leads"]),
  views: z.array(
    z.object({
      id: z.string(),
      name: z.string().trim().min(1).max(60),
      filters: z.array(projectFilterSchema),
    })
  ),
})
export type ProjectPreferences = z.infer<typeof projectPreferencesSchema>
export const defaultProjectPreferences = (): ProjectPreferences => ({
  layout: "List",
  grouping: "No grouping",
  ordering: "Manual",
  descending: false,
  closed: "All",
  properties: ["Health", "Priority", "Lead", "Target date", "Issues", "Status"],
  sidebar: false,
  favoriteIds: [],
  subscribedIds: [],
  detailSidebar: false,
  sidebarTab: "Health",
  views: [],
})
