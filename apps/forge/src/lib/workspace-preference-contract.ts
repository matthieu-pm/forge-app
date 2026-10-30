import { z } from "zod"
import {
  defaultIssueDisplay,
  displaySchema,
  emptyIssueFilters,
  filtersSchema,
} from "./issue-view-contract"
import {
  defaultProjectPreferences,
  projectPreferencesSchema,
} from "./project-view-contract"
import {
  defaultInitiativePreferences,
  initiativePreferencesSchema,
} from "./initiative-view-contract"
import {
  defaultInboxPreferences,
  emptyInboxFilters,
  inboxPreferencesSchema,
} from "./inbox-view"
import {
  defaultReviewDisplay,
  emptyReviewFilters,
  reviewDisplaySchema,
} from "./reviews-view"

const issueViewSchema = z.object({
  display: displaySchema,
  defaultDisplay: displaySchema,
  filters: filtersSchema,
})
const issueDefaults = () => ({
  display: defaultIssueDisplay(),
  defaultDisplay: defaultIssueDisplay(),
  filters: emptyIssueFilters(),
})
export const workspaceViewSchemas = {
  inbox: z.object({
    preferences: inboxPreferencesSchema,
    filters: z.object({
      type: z.array(z.string()),
      from: z.array(z.string()),
      project: z.array(z.string()),
      priority: z.array(z.string()),
      status: z.array(z.string()),
    }),
    unreadOnly: z.boolean(),
    priorityTab: z.enum(["priority", "other"]),
  }),
  myIssues: issueViewSchema.extend({
    version: z.literal(1),
    details: z.boolean(),
  }),
  teamIssues: issueViewSchema.extend({
    favorite: z.boolean(),
    notifications: z.array(
      z
        .string()
        .refine((value) => ["New issues", "Status changes"].includes(value))
    ),
    views: z.array(
      z.object({
        id: z.string(),
        name: z.string().trim().min(1).max(60),
        scope: z.enum(["active", "backlog", "all"]),
        filters: filtersSchema,
        display: displaySchema,
      })
    ),
  }),
  cycles: issueViewSchema.extend({ favorite: z.boolean() }),
  reviews: z.object({
    display: reviewDisplaySchema,
    filters: z.object({
      status: z.string(),
      author: z.string(),
      repository: z.string(),
      content: z.string(),
    }),
  }),
  projects: projectPreferencesSchema,
  initiatives: initiativePreferencesSchema,
  directory: z.object({
    favoriteIds: z.array(z.string()),
    ordering: z.enum(["Name", "Created", "Updated"]),
    descending: z.boolean(),
    properties: z.array(z.enum(["Owner", "Created", "Updated"])),
  }),
  teamHome: z.object({
    favorite: z.boolean(),
    collapsedSectionIds: z.array(z.string()),
    favoriteResourceIds: z.array(z.string()),
  }),
}
export type WorkspaceViewKind = keyof typeof workspaceViewSchemas
export type WorkspaceViewValues<TKind extends WorkspaceViewKind> = z.infer<
  (typeof workspaceViewSchemas)[TKind]
>
export const workspaceViewDefaults = {
  inbox: {
    preferences: defaultInboxPreferences,
    filters: emptyInboxFilters(),
    unreadOnly: false,
    priorityTab: "priority" as const,
  },
  myIssues: { ...issueDefaults(), version: 1 as const, details: false },
  teamIssues: {
    ...issueDefaults(),
    favorite: false,
    notifications: [],
    views: [],
  },
  cycles: { ...issueDefaults(), favorite: false },
  reviews: { display: defaultReviewDisplay, filters: emptyReviewFilters() },
  projects: defaultProjectPreferences(),
  initiatives: defaultInitiativePreferences(),
  directory: {
    favoriteIds: [],
    ordering: "Name" as const,
    descending: false,
    properties: ["Owner"] as Array<"Owner" | "Created" | "Updated">,
  },
  teamHome: {
    favorite: false,
    collapsedSectionIds: [],
    favoriteResourceIds: [],
  },
} satisfies { [TKind in WorkspaceViewKind]: WorkspaceViewValues<TKind> }
export function workspaceViewPrefix(
  kind: WorkspaceViewKind,
  resource = "main"
) {
  return `${kind}.${encodeURIComponent(resource).replaceAll(".", "%2E")}`
}
export function workspacePreferenceField(key: string): z.ZodType | undefined {
  const [kind, resource, ...path] = key.split(".")
  if (
    !Object.hasOwn(workspaceViewSchemas, kind) ||
    !resource ||
    resource.length > 500 ||
    !/^[A-Za-z0-9_%~-]+$/.test(resource) ||
    path.length === 0
  )
    return
  let schema: z.ZodType = workspaceViewSchemas[kind as WorkspaceViewKind]
  for (const segment of path) {
    if (
      !(schema instanceof z.ZodObject) ||
      !Object.hasOwn(schema.shape, segment)
    )
      return
    schema = schema.shape[segment]
  }
  return schema instanceof z.ZodObject ? undefined : schema
}
// Read each leaf independently; unknown/future values remain in the source record.
export function decodeWorkspaceView<TKind extends WorkspaceViewKind>(
  kind: TKind,
  resource: string,
  values: Record<string, unknown>
): WorkspaceViewValues<TKind> {
  const prefix = workspaceViewPrefix(kind, resource)
  function decode(schema: z.ZodType, defaults: unknown, path: string): unknown {
    if (schema instanceof z.ZodObject)
      return Object.fromEntries(
        Object.entries(schema.shape).map(([key, child]) => [
          key,
          decode(
            child as z.ZodType,
            (defaults as Record<string, unknown>)[key],
            `${path}.${key}`
          ),
        ])
      )
    const parsed = schema.safeParse(values[path])
    return parsed.success ? parsed.data : structuredClone(defaults)
  }
  return decode(
    workspaceViewSchemas[kind],
    workspaceViewDefaults[kind],
    prefix
  ) as WorkspaceViewValues<TKind>
}
