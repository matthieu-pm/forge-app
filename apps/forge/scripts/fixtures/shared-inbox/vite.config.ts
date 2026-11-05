import { fileURLToPath } from "node:url"
import { randomBytes } from "node:crypto"
import {
  createRunnableDevEnvironment,
  defineConfig,
  isRunnableDevEnvironment,
  mergeConfig,
} from "vite"
import base from "../../../vite.config"
import type { Plugin } from "vite"

const fixture = fileURLToPath(new URL(".", import.meta.url))
export default defineConfig(async (environment) => {
  const target = new URL(
    process.env.FORGE_INBOX_TEST_DATABASE_URL ?? "http://invalid"
  )
  if (
    target.hostname !== "127.0.0.1" ||
    target.port !== "56565" ||
    target.pathname !== "/for65_inbox_test"
  )
    throw new Error("Dedicated local FOR-65 database required")
  process.env.EVE_AGENT_RUNTIME_URL = "http://127.0.0.1:3999"
  for (const name of [
    "FORGE_AGENT_CHANNEL_SECRET",
    "FORGE_AGENT_MODEL_ACCESS_SECRET",
    "FORGE_AGENT_CAPABILITY_SECRET",
    "FORGE_AGENT_LOCAL_INGEST_SECRET",
  ])
    process.env[name] = randomBytes(32).toString("hex")
  process.env.FORGE_MODEL_CREDENTIAL_KEK = randomBytes(32).toString("base64")
  process.env.DATABASE_URL = process.env.FORGE_INBOX_TEST_DATABASE_URL
  process.env.FORGE_ENVIRONMENT = "development"
  process.env.BETTER_AUTH_URL = "http://localhost:3165"
  process.env.BETTER_AUTH_SECRET ??= randomBytes(32).toString("hex")
  process.env.FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED = "true"
  const config =
    typeof base === "function" ? await base(environment) : await base
  return mergeConfig(config, {
    environments: {
      scenario: {
        consumer: "server",
        dev: { createEnvironment: createRunnableDevEnvironment },
      },
    },
    resolve: {
      alias: [{ find: /^@\/db$/, replacement: `${fixture}/database.ts` }],
    },
    server: { host: "127.0.0.1", port: 3165, strictPort: true },
    plugins: [
      {
        name: "for65-local-scenario",
        configureServer(server) {
          server.middlewares.use("/__for65", async (request, response) => {
            if (request.method !== "POST") {
              response.statusCode = 405
              response.end()
              return
            }
            try {
              const scenarioEnvironment = server.environments.scenario
              if (!isRunnableDevEnvironment(scenarioEnvironment))
                throw new Error("Scenario environment unavailable")
              const scenario = await scenarioEnvironment.runner.import(
                `${fixture}/scenario.ts`
              )
              response.setHeader("content-type", "application/json")
              response.end(
                JSON.stringify(
                  await scenario.runScenario(request.url?.slice(1))
                )
              )
            } catch (error) {
              response.statusCode = 500
              response.end(String(error))
            }
          })
        },
      } satisfies Plugin,
    ],
  })
})
