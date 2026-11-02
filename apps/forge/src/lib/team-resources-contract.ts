import { z } from "zod"

/** Links are navigated by the user's browser, never fetched by the server. */
export function teamResourceUrl(raw: string): string | null {
  if (
    Array.from(raw).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    return null
  try {
    const url = new URL(raw.trim())
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}
export const resourceSectionSchema = z
  .object({ id: z.uuid(), name: z.string().trim().min(1).max(80) })
  .strict()
export const pinnedResourceSchema = z
  .object({
    id: z.uuid(),
    title: z.string().trim().min(1).max(200),
    url: z
      .string()
      .max(4000)
      .transform((value, ctx) => {
        const url = teamResourceUrl(value)
        if (!url) {
          ctx.addIssue({
            code: "custom",
            message: "Enter an http or https URL without credentials.",
          })
          return z.NEVER
        }
        return url
      }),
    sectionId: z.uuid().nullable(),
  })
  .strict()
export const teamResourceFieldsSchema = z
  .object({
    sections: z.array(resourceSectionSchema).max(100),
    links: z.array(pinnedResourceSchema).max(500),
    order: z
      .array(z.string().regex(/^(document|link):[0-9a-f-]{36}$/i))
      .max(2000),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [kind, ids] of [
      ["section", value.sections.map((s) => s.id)],
      ["link", value.links.map((l) => l.id)],
      ["order", value.order],
    ] as const)
      if (new Set(ids).size !== ids.length)
        ctx.addIssue({ code: "custom", message: `Duplicate ${kind} identity.` })
    if (
      value.links.some(
        (l) => l.sectionId && !value.sections.some((s) => s.id === l.sectionId)
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Choose an existing resource section.",
      })
  })
export const teamResourceCommandSchema = z
  .object({
    teamId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    fields: teamResourceFieldsSchema,
  })
  .strict()
export type TeamResourceFields = z.infer<typeof teamResourceFieldsSchema>
export type TeamResourceCommand = z.infer<typeof teamResourceCommandSchema>
export type TeamResourcesSnapshot = TeamResourceFields & { revision: number }
export type TeamResourcesResult =
  | { status: "saved"; revision: number }
  | { status: "conflict"; current: TeamResourcesSnapshot }
export const emptyTeamResources = (): TeamResourcesSnapshot => ({
  revision: 0,
  sections: [],
  links: [],
  order: [],
})
