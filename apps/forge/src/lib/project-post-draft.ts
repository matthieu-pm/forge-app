import { z } from "zod"
import { initiativeCommentSchema } from "./initiatives"

export const projectPostDraftSchema = z
  .object({
    kind: z.enum(["comment", "update"]),
    text: z.string().max(20000),
    health: z.enum(["On track", "At risk", "Off track"]),
    attachments: initiativeCommentSchema.shape.attachments.unwrap().max(3),
  })
  .strict()
export const projectPostDraftKey = (projectId: string) =>
  `forge:project-post-draft:v1:${projectId}`
