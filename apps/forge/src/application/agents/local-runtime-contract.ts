import { z } from "zod"

import {
  AGENT_EVENT_SOURCES,
  AGENT_EVENT_TYPES,
} from "@/application/agents/event-contract"
import {
  MODEL_REASONING_EFFORTS,
  modelReferenceSchema,
} from "@/application/agents/model-contract"
import { CAPABILITY_RISKS } from "@/application/agents/capability-contract"

export const startLocalAgentTurnInputSchema = z
  .object({
    runtimeId: z.enum(["codex", "claude"]),
    threadId: z.string().uuid(),
    message: z.string().trim().min(1).max(100_000),
    model: modelReferenceSchema,
    reasoningEffort: z.enum(MODEL_REASONING_EFFORTS).default("medium"),
    attachmentIds: z.array(z.string().uuid()).max(20).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.model.executionKind !== "external-agent") {
      context.addIssue({
        code: "custom",
        path: ["model", "executionKind"],
        message: "A local run requires an external-agent model.",
      })
    }
    if (!value.model.selectionId.startsWith(`local:${value.runtimeId}:`)) {
      context.addIssue({
        code: "custom",
        path: ["model", "selectionId"],
        message: "The model does not belong to the selected local runtime.",
      })
    }
  })

export const localRuntimeEventInputSchema = z
  .object({
    sourceEventId: z.string().trim().min(1).max(255),
    source: z
      .enum(AGENT_EVENT_SOURCES)
      .refine(
        (source) => source === "codex" || source === "claude",
        "Expected a local runtime source."
      ),
    type: z.enum(AGENT_EVENT_TYPES),
    occurredAt: z.iso.datetime(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()

export const ingestLocalRuntimeEventsInputSchema = z
  .object({
    runId: z.string().uuid(),
    events: z.array(localRuntimeEventInputSchema).min(1).max(100),
  })
  .strict()

export const checkpointLocalRuntimeSchema = z
  .object({
    runtimeSessionId: z.string().trim().min(1).max(255),
    runtimeRunId: z.string().trim().min(1).max(255),
  })
  .strict()

export const localRuntimeToolCallSchema = z
  .object({
    runId: z.string().uuid(),
    namespace: z.literal("forge"),
    tool: z.enum(["teams_list", "teams_get", "workspace_describe"]),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict()

export const runtimeApprovalPayloadSchema = z
  .object({
    approvalId: z.string().uuid().optional(),
    capabilityId: z.string().trim().min(1).max(255),
    capabilityVersion: z.string().trim().min(1).max(50).default("1"),
    risk: z.enum(CAPABILITY_RISKS),
    summary: z.string().trim().min(1).max(20_000),
    input: z.record(z.string(), z.unknown()).optional(),
    details: z.record(z.string(), z.unknown()).default({}),
    expiresAt: z.iso.datetime().optional(),
  })
  .passthrough()

export const localRuntimeApprovalPayloadSchema =
  runtimeApprovalPayloadSchema.extend({
    approvalId: z.string().uuid(),
    expiresAt: z.iso.datetime(),
  })

export type StartLocalAgentTurnInput = z.infer<
  typeof startLocalAgentTurnInputSchema
>
export type LocalRuntimeEventInput = z.infer<
  typeof localRuntimeEventInputSchema
>
