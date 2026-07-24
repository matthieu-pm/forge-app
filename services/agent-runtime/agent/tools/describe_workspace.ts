import { defineTool } from "eve/tools"
import { z } from "zod"

import { describeForgeWorkspace } from "../../src/forge-client.js"

const authAttributesSchema = z.object({
  workspaceId: z.string().min(1),
  runId: z.string().uuid(),
  forgeCapabilityToken: z.string().min(20),
})

export default defineTool({
  description:
    "Describe the caller's current Forge workspace. This is read-only.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const attributes = authAttributesSchema.parse(
      ctx.session.auth.current?.attributes
    )
    return describeForgeWorkspace(
      {
        workspaceId: attributes.workspaceId,
        runId: attributes.runId,
        capabilityToken: attributes.forgeCapabilityToken,
      },
      ctx.abortSignal
    )
  },
})
