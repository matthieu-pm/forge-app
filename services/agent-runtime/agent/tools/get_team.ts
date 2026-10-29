import { defineTool } from "eve/tools"
import { z } from "zod"

import { getForgeTeam } from "../../src/forge-client.js"

const authAttributesSchema = z.object({
  workspaceId: z.string().min(1),
  runId: z.string().uuid(),
  correlationId: z.string().uuid().optional(),
  forgeCapabilityToken: z.string().min(20),
})

export default defineTool({
  description:
    "Get one team by id or slug in the caller's current Forge workspace. This is read-only.",
  inputSchema: z
    .object({
      id: z.string().uuid().optional(),
      slug: z.string().min(1).optional(),
    })
    .refine((value) => Boolean(value.id) !== Boolean(value.slug), {
      message: "Provide exactly one team id or slug.",
    }),
  async execute(input, ctx) {
    const attributes = authAttributesSchema.parse(
      ctx.session.auth.current?.attributes
    )
    return getForgeTeam(
      {
        workspaceId: attributes.workspaceId,
        runId: attributes.runId,
        correlationId: attributes.correlationId,
        capabilityToken: attributes.forgeCapabilityToken,
      },
      input,
      ctx.abortSignal
    )
  },
})
