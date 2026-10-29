import {
  alertEnvelope,
  deliverAlert,
  evaluateMonitor,
  jobNames,
  monitorDestination,
  monitorEnvironment,
} from "./monitor"
import type { Finding, JobName, Metric } from "./monitor"
import type { MonitorStore } from "./monitor-store"

export function monitoredJobs(
  env: Record<string, string | undefined>
): Array<JobName> {
  const jobs = (
    env.FORGE_MONITORED_JOBS ??
    "agent.retention,product.retention,workflow.health"
  )
    .split(",")
    .filter(Boolean)
  if (!jobs.length || jobs.some((key) => !jobNames.includes(key as JobName)))
    throw new Error("Invalid monitored jobs.")
  return [...new Set(jobs)] as Array<JobName>
}

export async function dispatchFindings(
  findings: Array<Finding>,
  store: MonitorStore,
  env: Record<string, string | undefined>,
  fetcher: typeof fetch = fetch
) {
  let delivered = 0,
    suppressed = 0,
    failed = 0
  for (const finding of findings) {
    const alert = alertEnvelope(
      finding,
      monitorEnvironment(env),
      env.FORGE_SOURCE_REVISION
    )
    const lease = await store.claim(alert)
    if (!lease) {
      suppressed++
      continue
    }
    try {
      await deliverAlert(alert, env, fetcher)
      await store.acknowledge(alert.id, lease)
      delivered++
    } catch {
      await store.release(alert.id, lease)
      failed++
    }
  }
  return { delivered, suppressed, failed }
}

export async function runMonitor(
  store: MonitorStore,
  env: Record<string, string | undefined>,
  now = Date.now(),
  fetcher: typeof fetch = fetch
) {
  const started = performance.now()
  monitorDestination(env) // Validate before queries/leases; no partial silent monitoring.
  const jobs = monitoredJobs(env)
  const [heartbeats, samples] = await Promise.all([
    store.heartbeats(),
    store.samples(now),
  ])
  const requiredSignals: Array<Metric> = [
    "job-age",
    "event-age",
    "lease-age",
    "database-slots",
    "backlog",
  ]
  // Additional enabled surfaces must supply a real collector. Until they do, fail
  // visibly instead of substituting zero or claiming synthetic product coverage.
  for (const [flag, key] of [
    ["FORGE_MONITOR_OUTBOX", "outbox-age"],
    ["FORGE_MONITOR_UPLOADS", "failed-upload-age"],
    ["FORGE_MONITOR_ISSUE_JOURNEY", "issue-journey"],
    ["FORGE_MONITOR_ACCOUNT_JOURNEY", "account-journey"],
  ] as const) {
    if (env[flag] === "true" && !requiredSignals.includes(key))
      requiredSignals.push(key)
  }
  const findings = evaluateMonitor({
    now: now + (performance.now() - started),
    jobs,
    heartbeats,
    samples,
    requiredSignals,
  })
  const delivery = await dispatchFindings(findings, store, env, fetcher)
  return {
    status: delivery.failed
      ? "delivery-failed"
      : findings.length
        ? "unhealthy"
        : "healthy",
    findings: findings.length,
    ...delivery,
  }
}
