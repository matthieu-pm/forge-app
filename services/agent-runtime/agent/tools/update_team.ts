import { createHash } from "node:crypto"

import { defineTool } from "eve/tools"
import { always } from "eve/tools/approval"
import { z } from "zod"

import { updateForgeTeam } from "../../src/forge-client.js"

const authAttributesSchema = z.object({
  workspaceId: z.string().min(1),
  runId: z.string().uuid(),
  forgeCapabilityToken: z.string().min(20),
})

const settingsSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    identifier: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9]{0,4}$/)
      .optional(),
    description: z.string().trim().max(500).optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    estimationScheme: z
      .enum(["none", "exponential", "fibonacci", "linear", "tshirt"])
      .optional(),
    issueEmailEnabled: z.boolean().optional(),
    detailedHistoryEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((settings) => Object.keys(settings).length > 0, {
    message: "Choose at least one setting to update.",
  })

const inputSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    settings: settingsSchema,
  })
  .strict()

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    )
  }
  return value
}

export default defineTool({
  description:
    "Update settings for one Forge team. Every invocation requires explicit user approval and is replay-safe.",
  inputSchema,
  approval: always(),
  async execute(input, ctx) {
    if (
      ["0", "false", "off", "no"].includes(
        (process.env.FORGE_FEATURE_AGENT_WRITE_TOOLS ?? "")
          .trim()
          .toLowerCase()
      )
    ) {
      throw new Error("Agent write tools are disabled.")
    }
    const attributes = authAttributesSchema.parse(
      ctx.session.auth.current?.attributes
    )
    const inputHash = createHash("sha256")
      .update(JSON.stringify(canonicalize(input)))
      .digest("hex")
    return updateForgeTeam(
      {
        workspaceId: attributes.workspaceId,
        runId: attributes.runId,
        capabilityToken: attributes.forgeCapabilityToken,
      },
      input,
      `eve:${attributes.runId}:teams.update:${inputHash}`,
      ctx.abortSignal
    )
  },
})
