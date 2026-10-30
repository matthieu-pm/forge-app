import { createHash } from "node:crypto"

// FOR-24 accepted operational policy, version 1. No agent admission limits.
export const monitorPolicy = {
  retentionWarnSeconds: 1_800,
  retentionPageSeconds: 3_600,
  eventWarnSeconds: 30,
  eventPageSeconds: 60,
  jobPageSeconds: 3_600,
  leasePageSeconds: 300,
  uploadPageSeconds: 3_600,
  backlogFraction: 0.8,
  backlogSustainedSeconds: 300,
  signalMaxAgeSeconds: 120,
} as const
export const jobNames = [
  "agent.retention",
  "product.retention",
  "workflow.health",
  "calls.sync",
  "issues.retention",
] as const
export type JobName = (typeof jobNames)[number]
export type Metric =
  | "event-age"
  | "outbox-age"
  | "job-age"
  | "lease-age"
  | "failed-upload-age"
  | "backlog"
  | "database-slots"
  | "account-journey"
  | "issue-journey"
export type Sample = {
  key: Metric
  value: number | null
  observedAt: number
  since: number | null
  highSince?: number | null
}
export type Heartbeat = {
  key: JobName
  completedAt: number | null
  failedAt?: number | null
}
export type AlertCode =
  | "SWEEP_STALE"
  | "JOB_STALE"
  | "JOB_FAILED"
  | "EVENT_LAG"
  | "OUTBOX_LAG"
  | "LEASE_STALE"
  | "UPLOAD_FAILED"
  | "BACKLOG_HIGH"
  | "DATABASE_SATURATED"
  | "SYNTHETIC_FAILED"
  | "SIGNAL_MISSING"
  | "SIGNAL_STALE"
  | "READINESS_FAILED"
export type Finding = {
  code: AlertCode
  signal: string
  severity: "warning" | "page"
  since: number | null
  value: number | null
  threshold: number | null
}
export const RUNBOOK_URL =
  "https://github.com/matthieu-pm/forge-app/blob/main/docs/operations/readiness-and-alerts.md"
export function monitorEnvironment(env: Record<string, string | undefined>) {
  return (
    env.FORGE_ENVIRONMENT ??
    (env.VERCEL_ENV === "preview"
      ? "staging"
      : env.NODE_ENV === "production" || env.VERCEL_ENV === "production"
        ? "production"
        : "development")
  )
}

export function evaluateMonitor(input: {
  now: number
  jobs: Array<JobName>
  heartbeats: Array<Heartbeat>
  samples: Array<Sample>
  requiredSignals: Array<Metric>
}): Array<Finding> {
  const findings: Array<Finding> = []
  const add = (
    code: AlertCode,
    signal: string,
    severity: Finding["severity"],
    since: number | null,
    value: number | null,
    threshold: number | null
  ) => findings.push({ code, signal, severity, since, value, threshold })
  for (const key of input.jobs) {
    const h = input.heartbeats.find((row) => row.key === key)
    const completed = h?.completedAt
    if (
      completed == null ||
      !Number.isFinite(completed) ||
      completed > input.now + 5_000
    ) {
      add("SIGNAL_MISSING", key, "page", null, null, null)
      continue
    }
    if (h?.failedAt != null && h.failedAt > completed)
      add("JOB_FAILED", key, "page", h.failedAt, null, null)
    const age = (input.now - completed) / 1_000
    const retention = key.endsWith(".retention")
    if (age > monitorPolicy.jobPageSeconds)
      add(
        retention ? "SWEEP_STALE" : "JOB_STALE",
        key,
        "page",
        completed,
        age,
        monitorPolicy.jobPageSeconds
      )
    else if (retention && age > monitorPolicy.retentionWarnSeconds)
      add(
        "SWEEP_STALE",
        key,
        "warning",
        completed,
        age,
        monitorPolicy.retentionWarnSeconds
      )
  }
  for (const key of input.requiredSignals) {
    const sample = input.samples.find((row) => row.key === key)
    if (
      !sample ||
      sample.value == null ||
      !Number.isFinite(sample.value) ||
      sample.value < 0 ||
      !Number.isFinite(sample.observedAt) ||
      sample.observedAt > input.now + 5_000
    ) {
      add("SIGNAL_MISSING", key, "page", null, null, null)
      continue
    }
    if (
      input.now - sample.observedAt >
      monitorPolicy.signalMaxAgeSeconds * 1_000
    ) {
      add(
        "SIGNAL_STALE",
        key,
        "page",
        sample.observedAt,
        null,
        monitorPolicy.signalMaxAgeSeconds
      )
      continue
    }
    const { value, since } = sample
    if (key === "event-age" || key === "outbox-age") {
      if (value > 60)
        add(
          key === "event-age" ? "EVENT_LAG" : "OUTBOX_LAG",
          key,
          "page",
          since,
          value,
          60
        )
      else if (value > 30)
        add(
          key === "event-age" ? "EVENT_LAG" : "OUTBOX_LAG",
          key,
          "warning",
          since,
          value,
          30
        )
    } else if (key === "backlog") {
      if (
        value >= 0.8 &&
        sample.highSince != null &&
        sample.highSince <= input.now - 300_000
      )
        add("BACKLOG_HIGH", key, "warning", sample.highSince, value, 0.8)
    } else if (key === "database-slots") {
      if (value === 0) add("DATABASE_SATURATED", key, "page", since, value, 0)
    } else if (key.endsWith("journey")) {
      if (value !== 1) add("SYNTHETIC_FAILED", key, "page", since, value, 1)
    } else {
      const threshold = key === "lease-age" ? 300 : 3_600
      if (value > threshold)
        add(
          key === "lease-age"
            ? "LEASE_STALE"
            : key === "job-age"
              ? "JOB_STALE"
              : "UPLOAD_FAILED",
          key,
          "page",
          since,
          value,
          threshold
        )
    }
  }
  return findings
}

/** Stable for the same episode; warning → page has a separate delivery identity. */
export function alertEnvelope(
  finding: Finding,
  environment: string,
  sourceRevision?: string
) {
  if (!["development", "staging", "production"].includes(environment))
    throw new Error("Invalid monitor environment.")
  // Explicit projection: private/raw data on an adapter result cannot reach operators.
  const alert = {
    code: finding.code,
    signal: finding.signal,
    severity: finding.severity,
    since: finding.since,
    value: finding.value,
    threshold: finding.threshold,
  }
  const id = createHash("sha256")
    .update(
      JSON.stringify([
        environment,
        alert.code,
        alert.signal,
        alert.severity,
        alert.since,
      ])
    )
    .digest("hex")
  const runbookUrl = /^[a-f0-9]{40}$/.test(sourceRevision ?? "")
    ? RUNBOOK_URL.replace("/main/", `/${sourceRevision}/`)
    : RUNBOOK_URL
  return {
    version: 1,
    objectiveVersion: 1,
    id,
    environment,
    ...alert,
    runbookUrl,
  }
}
export type AlertEnvelope = ReturnType<typeof alertEnvelope>

export function monitorDestination(env: Record<string, string | undefined>) {
  const url = new URL(env.FORGE_OPERATIONS_WEBHOOK_URL ?? "")
  const local =
    env.FORGE_ENVIRONMENT === "development" &&
    env.NODE_ENV !== "production" &&
    env.VERCEL !== "1" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!local && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(env.FORGE_OPERATIONS_WEBHOOK_TOKEN ?? "")
  )
    throw new Error("Invalid operator webhook configuration.")
  return url
}

export async function deliverAlert(
  alert: AlertEnvelope,
  env: Record<string, string | undefined>,
  fetcher: typeof fetch = fetch
) {
  const url = monitorDestination(env)
  const response = await fetcher(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.FORGE_OPERATIONS_WEBHOOK_TOKEN}`,
      "idempotency-key": alert.id,
    },
    body: JSON.stringify(alert),
  })
  await response.body?.cancel()
  if (!response.ok) throw new Error("Operator alert delivery failed.")
}
