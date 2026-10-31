import { z } from "zod"

export const triagePriorities = [
  "No priority",
  "Urgent",
  "High",
  "Medium",
  "Low",
] as const
export const triageDraftSchema = z.object({
  title: z.string().max(240),
  description: z.string().max(10000),
  priority: z.enum(triagePriorities),
  dueDate: z.string().regex(/^$|^\d{4}-\d{2}-\d{2}$/),
  assignee: z.string().max(200).optional(),
  project: z.string().max(200).optional(),
  labels: z.string().max(1000).optional(),
  templateName: z.string().max(200).optional(),
  attachments: z
    .array(
      z.object({
        id: z.string().optional(),
        fileId: z.uuid().optional(),
        contentType: z.string().max(120).optional(),
        sizeBytes: z.number().int().positive().optional(),
        checksum: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        width: z.number().min(20).max(100).optional(),
        name: z.string().max(255),
        data: z
          .string()
          .max(2800000)
          .regex(/^(?:data:[a-zA-Z0-9.+/-]*;base64,[a-zA-Z0-9+/=]*|)$/),
      })
    )
    .max(5)
    .optional(),
})

export type TriageDraft = z.infer<typeof triageDraftSchema>
