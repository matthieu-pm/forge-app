import { defineTool } from "eve/tools"
import { z } from "zod"

import { listForgeTeams } from "../../src/forge-client.js"

const authAttributesSchema = z.object({
  workspaceId: z.string().min(1),
  runId: z.string().uuid(),
  correlationId: z.string().uuid().optional(),
  forgeCapabilityToken: z.string().min(20),
})

export default defineTool({
  description:
    "List teams in the caller's current Forge workspace. This is read-only.",
  inputSchema: z.object({
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  async execute(input, ctx) {
    if (process.env.EVE_EVAL_FIXTURE_MODE === "true") {
      return {
        items: [
          {
            id: "00000000-0000-4000-8000-000000000101",
            slug: "platform",
            identifier: "PLT",
            name: "Platform",
            timezone: "Europe/Paris",
          },
          {
            id: "00000000-0000-4000-8000-000000000102",
            slug: "growth",
            identifier: "GRO",
            name: "Growth",
            timezone: "America/New_York",
          },
        ],
        nextCursor: null,
      }
    }
    const attributes = authAttributesSchema.parse(
      ctx.session.auth.current?.attributes
    )
    return listForgeTeams(
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
