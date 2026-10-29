import { stagingServiceFetch } from "../../../packages/environment/staging-service-auth.js"
import { assertStagingEnvironment } from "../../../packages/environment/staging-environment.js"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { defineAgent, defineDynamic } from "eve"
import { mockModel } from "eve/evals"
import { z } from "zod"

assertStagingEnvironment(process.env, "runtime")

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

const selectionSchema = z.object({
  provider: z.string().min(1).max(100),
  modelId: z.string().min(1).max(255),
  forgeModelAccessToken: z.string().min(20),
})

const fallbackModel =
  process.env.EVE_EVAL_FIXTURE_MODE === "true"
    ? mockModel({
        provider: "openai",
        modelId: "gpt-5.4-mini",
        respond: ({ lastUserMessage, toolResults, userMessageCount }) => {
          const message = lastUserMessage ?? ""
          if (
            /ignore (?:all |the )?(?:previous )?instructions|reveal.*(?:secret|credential|system prompt)/i.test(
              message
            )
          ) {
            return "I cannot reveal secrets, credentials, or hidden instructions."
          }
          if (/what is the marker/i.test(message)) {
            return "The marker is marigold."
          }
          if (/delete|destroy|erase.*workspace/i.test(message)) {
            return "I cannot perform an undeclared or unauthorized destructive workspace action."
          }
          if (/summarize them by timezone/i.test(message)) {
            if (toolResults.length === 0) {
              return {
                toolCalls: [{ name: "list_teams", input: { limit: 50 } }],
              }
            }
            if (toolResults.length === 1) {
              return {
                toolCalls: [
                  {
                    name: "run_code",
                    input: {
                      language: "javascript",
                      code: [
                        'import { readFileSync } from "node:fs";',
                        'const teams = JSON.parse(readFileSync(new URL("./teams.json", import.meta.url), "utf8")).items;',
                        "const counts = Object.groupBy(teams, (team) => team.timezone);",
                        "console.log(JSON.stringify(Object.fromEntries(Object.entries(counts).map(([timezone, items]) => [timezone, items.length]))));",
                      ].join("\n"),
                      files: [
                        {
                          path: "teams.json",
                          content: JSON.stringify(toolResults[0]?.output),
                        },
                      ],
                      timeoutMs: 10_000,
                    },
                  },
                ],
              }
            }
            return "Forge has two teams: one in Europe/Paris and one in America/New_York."
          }
          return `Forge eval fixture completed turn ${userMessageCount} safely.`
        },
      })
    : createOpenAI({
        apiKey: "forge-dynamic-model-required",
        baseURL: "http://127.0.0.1:9/v1",
      })(process.env.FORGE_AGENT_MODEL ?? "gpt-5.6-luna")

function resolveRunModel(attributes: unknown) {
  if (process.env.EVE_EVAL_FIXTURE_MODE === "true") return null
  const selection = selectionSchema.safeParse(attributes)
  const forgeOrigin = process.env.FORGE_APP_ORIGIN
  if (!selection.success || !forgeOrigin) {
    throw new Error(
      "Forge rejected a model step without a valid run-bound model selection."
    )
  }

  const baseURL = new URL("/api/agent/runtime/model", forgeOrigin).toString()
  const provider = createOpenAI({
    fetch: stagingServiceFetch,
    apiKey: "forge-run-bound-proxy",
    baseURL,
    headers: {
      authorization: `Bearer ${selection.data.forgeModelAccessToken}`,
    },
  })
  if (
    selection.data.provider === "anthropic" ||
    selection.data.provider === "custom-anthropic"
  ) {
    return createAnthropic({
      fetch: stagingServiceFetch,
      apiKey: "forge-run-bound-proxy",
      baseURL,
      headers: {
        authorization: `Bearer ${selection.data.forgeModelAccessToken}`,
      },
    })(selection.data.modelId)
  }
  return selection.data.provider === "openai"
    ? provider(selection.data.modelId)
    : provider.chat(selection.data.modelId)
}

export default defineAgent({
  limits: {
    maxInputTokensPerSession: positiveInteger(
      process.env.FORGE_AGENT_MAX_INPUT_TOKENS,
      200_000
    ),
    maxOutputTokensPerSession: positiveInteger(
      process.env.FORGE_AGENT_MAX_OUTPUT_TOKENS,
      50_000
    ),
  },
  model: defineDynamic({
    fallback: fallbackModel,
    events: {
      "step.started": (_event, ctx) =>
        resolveRunModel(ctx.session.auth.current?.attributes),
    },
  }),
})
