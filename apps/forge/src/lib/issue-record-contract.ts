import { z } from "zod"
import { pullRequestMetadataSchema } from "./issue-pull-requests"
import { triageDraftSchema } from "./triage-record-contract"

const linkSchema = z.object({
  pullRequest: pullRequestMetadataSchema.optional(),
  title: z.string().max(200),
  url: z
    .string()
    .url()
    .refine((url) => /^https?:\/\//i.test(url), "Use an http or https link."),
})
const reactionSchema = z.object({
  emoji: z.string(),
  users: z.array(z.string()),
})
const commentSchema = z.object({
  id: z.string(),
  parentId: z.string().default(""),
  attachmentId: z.string().default(""),
  attachmentName: z.string().max(255).optional(),
  resolved: z.boolean().default(false),
  author: z.string(),
  body: z.string().max(10000),
  createdAt: z.string().datetime(),
  edited: z.boolean().default(false),
  deleted: z.boolean().default(false),
  attachments: triageDraftSchema.shape.attachments,
  reactions: z.array(reactionSchema).default([]),
})
export const issueDraftSchema = triageDraftSchema.extend({
  triage: z.boolean().default(false),
  snoozed: z.boolean().default(false),
  status: z.string().min(1),
  cycle: z.string().default(""),
  parentId: z.string().default(""),
  links: z.array(linkSchema).default([]),
  subIssues: z.array(z.string().trim().min(1).max(240)).default([]),
  recurrence: z.enum(["", "daily", "weekly", "monthly"]).default(""),
  agent: z.string().default(""),
  agentSession: z.string().default(""),
  subscribers: z.string().default(""),
  milestone: z.string().default(""),
  autoClosed: z.boolean().default(false),
  descriptionDoc: z.record(z.string(), z.unknown()).nullable().default(null),
  reactions: z.array(reactionSchema).default([]),
  comments: z.array(commentSchema).default([]),
  activity: z
    .array(
      z.object({
        id: z.string(),
        author: z.string(),
        text: z.string(),
        createdAt: z.string(),
        automaticAssignment: z
          .object({ from: z.literal(""), to: z.string() })
          .optional(),
        field: z
          .enum([
            "status",
            "priority",
            "assignee",
            "labels",
            "project",
            "cycle",
          ])
          .optional(),
        link: linkSchema.optional(),
        linkAction: z.enum(["linked", "unlinked"]).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      })
    )
    .default([]),
  favorite: z.boolean().default(false),
})
export type IssueDraft = z.infer<typeof issueDraftSchema>
export const blankIssueDraft = (status = "todo"): IssueDraft =>
  issueDraftSchema.parse({
    title: "",
    description: "",
    status,
    priority: "No priority",
    dueDate: "",
  })
export const issueSchema = issueDraftSchema.extend({
  revision: z.number().int().nonnegative().optional(),
  legacyFingerprint: z.string().optional(),
  id: z.string(),
  number: z.number().int().positive(),
  title: z.string().trim().min(1).max(240),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  statusChangedAt: z.string().datetime(),
  creator: z.string(),
  suggestedLabel: z.string(),
  completedAt: z.string().nullable(),
  recurrenceSpawned: z.boolean().default(false),
})
export type TeamIssue = z.infer<typeof issueSchema>
