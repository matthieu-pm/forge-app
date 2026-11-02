import { z } from "zod"
import { templateScopeSchema } from "./template-contract"

export const templateApplicationQuerySchema = templateScopeSchema.extend({
  kind: z.enum(["issue", "project"]).optional(),
})
export const applyTemplateSchema = z
  .object({
    commandKey: z.uuid(),
    templateId: z.uuid(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    teamId: z.uuid().optional(),
    triage: z.boolean().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    answers: z
      .record(
        z.string().max(200),
        z.union([z.string().max(10000), z.boolean(), z.number().finite()])
      )
      .default({}),
  })
  .strict()
export const browserApplyTemplateSchema = applyTemplateSchema
  .extend({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict()
export type ApplyTemplate = z.infer<typeof applyTemplateSchema>
export type TemplateApplicationResult =
  | {
      ok: true
      replayed: boolean
      value: {
        kind: "issue" | "project"
        id: string
        issueIds: Array<string>
        projectIds: Array<string>
      }
    }
  | { ok: false; code: "TEMPLATE_VALIDATION"; message: string }
