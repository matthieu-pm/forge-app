import "@tanstack/react-start/server-only"
import { emitTelemetry } from "../../../../../packages/telemetry/server"
import { stagingServiceFetch } from "../../../../../packages/environment/staging-service-auth"
import { STAGING } from "../../../../../packages/environment/staging-environment"
import {
  alertEnvelope,
  deliverAlert,
  monitorDestination,
  monitorEnvironment,
} from "./monitor"
import { runMonitor } from "./monitor-runner"
import { monitorStore } from "./monitor-store"
import { checkWebReadiness } from "./readiness.server"

export async function runWebMonitor() {
  monitorDestination(process.env)
  const fetcher =
    process.env.FORGE_ENVIRONMENT === "staging" &&
    new URL(process.env.FORGE_OPERATIONS_WEBHOOK_URL!).origin ===
      STAGING.runtimeOrigin
      ? stagingServiceFetch
      : fetch
  const code = await checkWebReadiness()
  if (code !== "READY") {
    // Database/schema failure must still reach the operator. The receiver dedups
    // by this hourly fallback key while the normal SQL receipt is unavailable.
    const alert = alertEnvelope(
      {
        code: "READINESS_FAILED",
        signal: code,
        severity: "page",
        since: Math.floor(Date.now() / 3_600_000) * 3_600_000,
        value: null,
        threshold: null,
      },
      monitorEnvironment(process.env),
      process.env.FORGE_SOURCE_REVISION
    )
    await deliverAlert(alert, process.env, fetcher)
    return {
      status: "unhealthy",
      findings: 1,
      delivered: 1,
      suppressed: 0,
      failed: 0,
    }
  }
  const { databaseClient } = await import("@/db")
  let result
  try {
    result = await runMonitor(
      monitorStore(databaseClient),
      process.env,
      Date.now(),
      fetcher
    )
  } catch {
    const alert = alertEnvelope(
      {
        code: "SIGNAL_MISSING",
        signal: "operational-collector",
        severity: "page",
        since: Math.floor(Date.now() / 3_600_000) * 3_600_000,
        value: null,
        threshold: null,
      },
      monitorEnvironment(process.env),
      process.env.FORGE_SOURCE_REVISION
    )
    await deliverAlert(alert, process.env, fetcher)
    return {
      status: "collector-failed",
      findings: 1,
      delivered: 1,
      suppressed: 0,
      failed: 1,
    }
  }
  emitTelemetry("job.health", "operations.monitor", {
    count: result.delivered,
    failures: result.failed,
  })
  return result
}
