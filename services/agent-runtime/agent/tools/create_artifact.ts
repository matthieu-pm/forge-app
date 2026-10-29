import { defineTool } from "eve/tools"
import { z } from "zod"

import { createForgeArtifact } from "../../src/forge-client.js"

const authAttributesSchema = z.object({
  workspaceId: z.string().min(1),
  runId: z.string().uuid(),
  correlationId: z.string().uuid().optional(),
  forgeCapabilityToken: z.string().min(20),
})

export default defineTool({
  description:
    "Save a bounded file generated during this run and show it as a downloadable Forge artifact.",
  inputSchema: z.object({
    kind: z.enum(["file", "text", "data", "report", "code"]).default("file"),
    name: z.string().trim().min(1).max(200),
    contentType: z.string().trim().min(1).max(120),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
    content: z.string().max(8_000_000),
  }),
  async execute(input, ctx) {
    const attributes = authAttributesSchema.parse(
      ctx.session.auth.current?.attributes
    )
    return createForgeArtifact(
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
