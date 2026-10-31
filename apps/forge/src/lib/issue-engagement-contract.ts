import { z } from "zod"

export const normalizeReactionEmoji = (value: string) =>
  value.replace(/[\uFE0E\uFE0F]/g, "")

const identity = {
  commandKey: z.uuid(),
  teamId: z.uuid(),
  issueId: z.uuid(),
}
export const issueEngagementCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...identity,
      action: z.literal("subscription"),
      subscribed: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...identity,
      action: z.literal("reaction"),
      // Omitted for the issue description; otherwise targets a comment or reply.
      commentId: z.uuid().optional(),
      emoji: z.string().min(1).max(32).transform(normalizeReactionEmoji),
      present: z.boolean(),
    })
    .strict(),
])
export type IssueEngagementCommand = z.infer<
  typeof issueEngagementCommandSchema
>
export const browserIssueEngagementSchema = z
  .object({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
    command: issueEngagementCommandSchema,
  })
  .strict()
export const issueSubscriberIds = (value: string) => [
  ...new Set(
    value
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  ),
]
