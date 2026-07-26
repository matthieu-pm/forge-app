import { z } from "zod"

import { modelReferenceSchema } from "@/application/agents/model-contract"

export const AGENT_THREAD_STATUSES = ["active", "archived"] as const
export const AGENT_RUNTIME_KINDS = ["eve", "codex", "claude"] as const
export const AGENT_RUN_STATES = [
  "created",
  "connecting",
  "running",
  "waiting-for-approval",
  "reconnecting",
  "cancelled",
  "failed",
  "completed",
] as const

export const createAgentThreadInputSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    runtimeKind: z.enum(AGENT_RUNTIME_KINDS).default("eve"),
  })
  .strict()

export const startAgentTurnInputSchema = z
  .object({
    threadId: z.string().uuid(),
    message: z.string().trim().min(1).max(100_000),
    selectionMode: z.enum(["auto", "manual"]),
    model: modelReferenceSchema.optional(),
    reasoningEffort: z
      .enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
      .optional(),
    attachmentIds: z.array(z.string().uuid()).max(20).default([]),
    preferredOpenAIConnectionId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.selectionMode === "manual" && !value.model) {
      context.addIssue({
        code: "custom",
        message: "Manual selection requires a model.",
        path: ["model"],
      })
    }

    if (value.selectionMode === "auto" && value.model) {
      context.addIssue({
        code: "custom",
        message: "Auto selection cannot pin a model.",
        path: ["model"],
      })
    }
    if (value.selectionMode === "manual" && value.preferredOpenAIConnectionId) {
      context.addIssue({
        code: "custom",
        message: "Manual selection cannot set an Auto connection.",
        path: ["preferredOpenAIConnectionId"],
      })
    }
  })

export const resolveAgentApprovalInputSchema = z
  .object({
    approvalId: z.string().uuid(),
    decision: z.enum(["approved", "denied"]),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

export const agentCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("thread.create"),
      input: createAgentThreadInputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("turn.start"),
      input: startAgentTurnInputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("run.cancel"),
      input: z.object({ runId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("approval.resolve"),
      input: resolveAgentApprovalInputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("thread.rename"),
      input: z
        .object({
          threadId: z.string().uuid(),
          title: z.string().trim().min(1).max(160),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("thread.archive"),
      input: z.object({ threadId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("thread.reopen"),
      input: z.object({ threadId: z.string().uuid() }).strict(),
    })
    .strict(),
])

export type AgentCommand = z.infer<typeof agentCommandSchema>
export type CreateAgentThreadInput = z.infer<
  typeof createAgentThreadInputSchema
>
export type StartAgentTurnInput = z.infer<typeof startAgentTurnInputSchema>
export type ResolveAgentApprovalInput = z.infer<
  typeof resolveAgentApprovalInputSchema
>
