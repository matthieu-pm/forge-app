import { z } from "zod"
import { teamIconSchema } from "./team-contract"
import {
  defaultIssueDisplay,
  displaySchema,
  emptyIssueFilters,
  filtersSchema,
} from "./team-issues"
import {
  defaultProjectPreferences,
  projectFilterSchema,
  projectPreferencesSchema,
} from "./projects"

const common = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000),
  icon: teamIconSchema.nullable(),
  ownerId: z.string().min(1),
  visibility: z.enum(["personal", "workspace", "team"]),
  teamId: z.string().min(1).optional(),
  favorite: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export const customViewSchema = z
  .discriminatedUnion("kind", [
    common.extend({
      kind: z.literal("issues"),
      filters: filtersSchema,
      display: displaySchema,
    }),
    common.extend({
      kind: z.literal("projects"),
      filters: z.array(projectFilterSchema),
      display: projectPreferencesSchema,
    }),
  ])
  .refine((view) => view.visibility !== "team" || Boolean(view.teamId), {
    message: "A team view needs a team.",
    path: ["teamId"],
  })
export type CustomView = z.infer<typeof customViewSchema>
export type CustomViewKind = CustomView["kind"]
export const customViewsSchema = z
  .object({ version: z.literal(1), views: z.array(customViewSchema) })
  .refine(
    (store) =>
      new Set(store.views.map((view) => view.id)).size === store.views.length,
    "Saved view IDs must be unique."
  )

export function parseCustomViews(raw: string | null) {
  return customViewsSchema.parse(
    raw === null ? { version: 1, views: [] } : JSON.parse(raw)
  )
}
export const customViewsKey = (workspaceId: string, userId: string) =>
  `forge:workspace:${workspaceId}:custom-views:v1:${userId}`

export function newCustomView(
  kind: "issues",
  userId: string,
  teamId?: string
): Extract<CustomView, { kind: "issues" }>
export function newCustomView(
  kind: "projects",
  userId: string,
  teamId?: string
): Extract<CustomView, { kind: "projects" }>
export function newCustomView(
  kind: CustomViewKind,
  userId: string,
  teamId?: string
): CustomView
export function newCustomView(
  kind: CustomViewKind,
  userId: string,
  teamId?: string
): CustomView {
  const at = new Date().toISOString()
  const metadata = {
    id: crypto.randomUUID(),
    name: kind === "issues" ? "All issues" : "All projects",
    description: "",
    icon: null,
    ownerId: userId,
    visibility: "personal" as const,
    ...(teamId ? { teamId } : {}),
    favorite: false,
    createdAt: at,
    updatedAt: at,
  }
  return kind === "issues"
    ? {
        ...metadata,
        kind,
        filters: emptyIssueFilters(),
        display: defaultIssueDisplay(),
      }
    : { ...metadata, kind, filters: [], display: defaultProjectPreferences() }
}

/** A team directory only includes views scoped to that team; workspace lists include all scopes. */
export function visibleCustomViews(
  views: Array<CustomView>,
  kind: CustomViewKind,
  teamId?: string
) {
  return views.filter(
    (view) => view.kind === kind && (!teamId || view.teamId === teamId)
  )
}
