import "@tanstack/react-start/server-only"
import { neon } from "@neondatabase/serverless"
import { inspectFileStorage } from "../../../../../packages/environment/file-storage"
import { inspectServiceConfiguration } from "../../../../../packages/environment/service-config"
import { assertStagingEnvironment } from "../../../../../packages/environment/staging-environment"
import { stagingServiceFetch } from "../../../../../packages/environment/staging-service-auth"
import {
  healthResponse,
  readinessCode,
} from "../../../../../packages/telemetry/health"
import { schemaIsReady } from "./readiness-schema"
import type { MonitorSql } from "./monitor-store"

const disabled = (value: string | undefined) =>
  value != null &&
  ["false", "0", "off", "no"].includes(value.toLowerCase().trim())

export async function checkWebReadiness() {
  let client: MonitorSql
  return readinessCode({
    configuration: async () => {
      assertStagingEnvironment(process.env, "web")
      return inspectServiceConfiguration(process.env, "app").ready
    },
    database: async () => {
      const query = neon(process.env.DATABASE_URL!, { fullResults: true })
      client = {
        query: (text, values) =>
          query.query(text, values, {
            fetchOptions: { signal: AbortSignal.timeout(4_000) },
          }),
      }
      await client.query("SELECT 1")
      return true
    },
    schema: () => schemaIsReady(client),
    ...(!disabled(process.env.FORGE_FEATURE_AGENT_UI) &&
    !disabled(process.env.FORGE_FEATURE_AGENT_EVE_RUNTIME)
      ? {
          runtime: async () => {
            const response = await stagingServiceFetch(
              new URL("/health/ready", process.env.EVE_AGENT_RUNTIME_URL),
              { redirect: "error", signal: AbortSignal.timeout(4_000) }
            )
            if (
              !response.ok ||
              !response.headers
                .get("content-type")
                ?.includes("application/json")
            ) {
              await response.body?.cancel()
              return false
            }
            const value = (await response.json()) as {
              code?: string
              status?: string
            }
            return value.code === "READY" && value.status === "ok"
          },
        }
      : {}),
    ...(inspectFileStorage(process.env).adapter === "vercel-private"
      ? {
          storage: async () => {
            const { list } = await import("@vercel/blob")
            // A bounded metadata read tests credentials/network without creating an object
            // or disclosing names. Object roundtrip/isolation remains the storage gate.
            await list({
              token: process.env.BLOB_READ_WRITE_TOKEN,
              limit: 1,
              prefix: "forge/operations-health/",
              abortSignal: AbortSignal.timeout(4_000),
            })
            return true
          },
        }
      : {}),
  })
}
export async function webReadinessResponse() {
  return healthResponse(await checkWebReadiness())
}
