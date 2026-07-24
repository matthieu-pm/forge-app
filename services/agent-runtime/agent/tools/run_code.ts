import { defineTool } from "eve/tools"

import { runCode, runCodeInputSchema } from "../../src/code-runtime.js"

export default defineTool({
  description:
    "Run bounded JavaScript, TypeScript, or a shell script in an isolated, deny-network sandbox. It can use only the provided data files and has no Forge credentials.",
  inputSchema: runCodeInputSchema,
  async execute(input, ctx) {
    const disabled = ["0", "false", "off", "no"].includes(
      (process.env.FORGE_FEATURE_AGENT_CODE_MODE ?? "").trim().toLowerCase()
    )
    if (disabled) throw new Error("Agent code mode is disabled.")
    if (process.env.EVE_EVAL_FIXTURE_MODE === "true") {
      runCodeInputSchema.parse(input)
      return {
        language: input.language,
        exitCode: 0,
        stdout: '{"Europe/Paris":1,"America/New_York":1}\n',
        stderr: "",
      }
    }
    return runCode({
      sandbox: await ctx.getSandbox(),
      rawInput: input,
      signal: ctx.abortSignal,
    })
  },
})
