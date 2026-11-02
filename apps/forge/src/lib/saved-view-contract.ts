import { z } from "zod"
import { teamIconSchema } from "./team-contract"
import { issueQuerySchema } from "./issue-query-contract"
import {
  projectFilterSchema,
  projectPreferencesSchema,
} from "./project-view-contract"
import type { InitiativeProject } from "./initiatives"
import type { CustomView } from "./custom-views"

const metadata = z.object({
  version: z.literal(1),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000),
  icon: teamIconSchema.nullable(),
  visibility: z.enum(["personal", "workspace", "team"]),
  teamId: z.uuid().optional(),
})
const issueFilters = issueQuerySchema.shape.filters
  .removeDefault()
  .extend({
    rules: z
      .array(
        issueQuerySchema.shape.filters
          .removeDefault()
          .shape.rules.element.extend({
            id: z.string().max(200),
            value: z.string().max(500),
          })
          .strict()
      )
      .max(20),
  })
  .strict()
export const savedViewDefinitionSchema = z
  .discriminatedUnion("kind", [
    metadata
      .extend({
        kind: z.literal("issues"),
        filters: issueFilters,
        display: issueQuerySchema.shape.display.removeDefault().strict(),
      })
      .strict(),
    metadata
      .extend({
        kind: z.literal("projects"),
        filters: z
          .array(
            projectFilterSchema.extend({ value: z.string().max(500) }).strict()
          )
          .max(20),
        display: projectPreferencesSchema
          .extend({
            properties: projectPreferencesSchema.shape.properties.max(30),
            favoriteIds: z.array(z.string()).max(0),
            subscribedIds: z.array(z.string()).max(0),
            views: z.array(z.never()).max(0),
          })
          .strict(),
      })
      .strict(),
  ])
  .refine(
    (v) => v.visibility !== "team" || Boolean(v.teamId),
    "A team view needs a team."
  )
export type SavedProjectQuery = {
  projects: Array<InitiativeProject>
  /** Unfiltered readable identities distinguish access loss from filter exclusion. */
  authorizedProjectIds: Array<string>
}
export type SavedViewDefinition = z.infer<typeof savedViewDefinitionSchema>
export type SavedView = CustomView & { revision: number; canEdit: boolean }
export type SavedViewDirectory = {
  workspaceId: string
  userId: string
  sessionId: string
  enabled: boolean
  views: Array<SavedView>
  error: string
}
export const savedViewMutationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("save"),
      id: z.uuid(),
      expectedRevision: z.number().int().nonnegative().nullable(),
      definition: savedViewDefinitionSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("delete"),
      id: z.uuid(),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      action: z.literal("favorite"),
      id: z.uuid(),
      favorite: z.boolean(),
    })
    .strict(),
])
export const savedViewIdentitySchema = z
  .object({ workspaceId: z.string().min(1), sessionId: z.string().min(1) })
  .strict()
export const browserSavedViewMutationSchema = savedViewIdentitySchema
  .extend({ commandKey: z.uuid(), mutation: savedViewMutationSchema })
  .strict()
export function viewDefinition(view: CustomView): SavedViewDefinition {
  const {
    name,
    description,
    icon,
    visibility,
    teamId,
    kind,
    filters,
    display,
  } = view
  return savedViewDefinitionSchema.parse({
    version: 1,
    name,
    description,
    icon,
    visibility,
    ...(teamId ? { teamId } : {}),
    kind,
    filters,
    display:
      kind === "projects"
        ? { ...display, favoriteIds: [], subscribedIds: [], views: [] }
        : display,
  })
}
