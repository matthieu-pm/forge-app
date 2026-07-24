import { defineTool } from "eve/tools"
import { z } from "zod"

import {
  capabilityManifestEntrySchema,
  executeProgram,
} from "../../src/program-runtime.js"

const authAttributesSchema = z.object({
  workspaceId: z.string().min(1),
  runId: z.string().uuid(),
  forgeCapabilityToken: z.string().min(20),
})

export default defineTool({
  description:
    "Run JavaScript in the isolated sandbox. The program can call only declared Forge capabilities through await forge.call(id, input, options). A manifest containing writes requires approval and every write needs an idempotency key.",
  inputSchema: z.object({
    language: z.literal("javascript"),
    code: z.string().min(1).max(100_000),
    capabilityManifest: z.array(capabilityManifestEntrySchema).min(1).max(10),
    timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
  }),
  approval: ({ toolInput }) =>
    toolInput?.capabilityManifest.some(
      (entry) => entry.id === "teams.update"
    )
      ? "user-approval"
      : "not-applicable",
  async execute(input, ctx) {
    const disabled = (name: string) =>
      ["0", "false", "off", "no"].includes(
        (process.env[name] ?? "").trim().toLowerCase()
      )
    if (
      disabled("FORGE_FEATURE_AGENT_CODE_MODE") ||
      disabled("FORGE_FEATURE_AGENT_PROGRAMMATIC_TOOLS")
    ) {
      throw new Error("Programmatic Forge tools are disabled.")
    }
    if (
      input.capabilityManifest.some((entry) => entry.id === "teams.update") &&
      disabled("FORGE_FEATURE_AGENT_WRITE_TOOLS")
    ) {
      throw new Error("Agent write tools are disabled.")
    }
    const attributes = authAttributesSchema.parse(
      ctx.session.auth.current?.attributes
    )
    const sandbox = await ctx.getSandbox()
    return executeProgram({
      sandbox,
      caller: {
        workspaceId: attributes.workspaceId,
        runId: attributes.runId,
        capabilityToken: attributes.forgeCapabilityToken,
      },
      input,
      signal: ctx.abortSignal,
    })
  },
})
