import { z } from "zod"

export const initiativeProperties = [
  "ID",
  "Description",
  "Owner",
  "Status",
  "Priority",
  "Contributing teams",
  "Health",
  "Projects",
  "Active projects",
  "Target date",
  "Created",
  "Updated",
  "Completed",
  "Labels",
] as const
export type InitiativeProperty = (typeof initiativeProperties)[number]
export const initiativePreferencesSchema = z.object({
  grouping: z.enum([
    "No grouping",
    "Status",
    "Priority",
    "Owner",
    "Contributing team",
    "Health",
  ]),
  ordering: z.enum([
    "Manual",
    "Name",
    "Priority",
    "Owner",
    "Target",
    "Health",
    "Created",
    "Updated",
  ]),
  descending: z.boolean(),
  properties: z.array(z.enum(initiativeProperties)),
  sidebar: z.boolean(),
  sidebarTab: z.enum(["Owner", "Contributing team", "Health"]),
  favoriteIds: z.array(z.string()).default([]),
  subscribedIds: z.array(z.string()).default([]),
  detailSidebar: z.boolean().default(false),
})
export type InitiativePreferences = z.infer<typeof initiativePreferencesSchema>
export const defaultInitiativePreferences = (): InitiativePreferences => ({
  grouping: "No grouping",
  ordering: "Manual",
  descending: false,
  properties: [
    "Description",
    "Priority",
    "Owner",
    "Target date",
    "Projects",
    "Health",
    "Active projects",
  ],
  sidebar: false,
  sidebarTab: "Owner",
  favoriteIds: [],
  subscribedIds: [],
  detailSidebar: false,
})
