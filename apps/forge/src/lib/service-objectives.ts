import { z } from "zod"

/** FOR-24 decision/evidence contract only. No runtime admission or SLA claim. */
export const SERVICE_OBJECTIVES_VERSION = 1
export const SERVICE_WORKLOAD_ID = "launch-v1"

type Decision = {
  status: "accepted" | "proposed"
  reference: string
}
export const serviceObjectiveDecisions: Record<
  "targets" | "workloadAndMeasurements" | "capacity",
  Decision
> = {
  targets: {
    status: "accepted",
    reference: "User decision in FOR-24 implementation chat, 2026-10-29",
  },
  workloadAndMeasurements: {
    status: "accepted",
    reference:
      "User accepted the launch-v1 baseline and measurement rules in the FOR-24 implementation chat, 2026-10-29",
  },
  capacity: {
    status: "accepted",
    reference:
      "User accepted the operational capacity table in the FOR-24 implementation chat, 2026-10-29",
  },
}

export const serviceTargets = {
  coreSuccessRatio: 0.995,
  availabilityWindowSeconds: 7 * 24 * 60 * 60,
  listP95Ms: 500,
  writeP95Ms: 1_000,
  notificationMaxSeconds: 60,
  recoveryPointSeconds: 3_600,
  recoveryTimeSeconds: 14_400,
} as const

export const serviceWorkload = {
  workspaces: 100,
  accounts: 1_000,
  teams: 500,
  issues: 100_000,
  comments: 1_000_000,
  documents: 10_000,
  fileBytes: 100_000_000_000,
  concurrentClients: 100,
  requestsPerSecond: 50,
  readPercent: 80,
  agentTurns: 20,
  uploads: 4,
  importExportJobs: 2,
  notificationsPerMinute: 100,
  syncJobs: 2,
  retentionSweeps: 1,
} as const

export const serviceRegions = {
  web: "iad1",
  runtime: "iad1",
  database: "eu-west-2",
  objects: "London",
} as const

const label = z.string().trim().min(1)
const sha = z.string().regex(/^[a-f0-9]{40}$/)
const checksum = z.string().regex(/^[a-f0-9]{64}$/)
const count = z.number().int().nonnegative().safe()
const duration = z.number().nonnegative()
const artifact = z.object({ reference: label, sha256: checksum }).strict()
const coreOperations = [
  "auth-session",
  "issue-list",
  "issue-get",
  "issue-create",
  "issue-update",
  "issue-comment",
  "workspace-team-read",
] as const
const requestResult = z
  .object({ attempts: count.positive(), failures: count })
  .strict()
  .refine(
    (result) => result.failures <= result.attempts,
    "Invalid failure count"
  )

const base = z.object({
  objectiveVersion: z.literal(SERVICE_OBJECTIVES_VERSION),
  workloadId: z.literal(SERVICE_WORKLOAD_ID),
  sourceRevision: sha,
  operator: label,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  rawMeasurements: artifact,
  exclusions: artifact,
  environment: z
    .object({
      name: label,
      webDeploymentId: label,
      runtimeDeploymentId: label,
      databaseIdentity: label,
      schemaFingerprint: checksum,
      storageIdentity: label,
      configuration: artifact,
      regions: z
        .object({ web: label, runtime: label, database: label, objects: label })
        .strict(),
    })
    .strict(),
  workload: z
    .object({
      manifest: artifact,
      runnerRevision: sha,
      dimensions: z
        .object(
          Object.fromEntries(
            Object.keys(serviceWorkload).map((key) => [key, count])
          )
        )
        .strict(),
    })
    .strict(),
})

export const serviceCandidateSchema = base
  .pick({
    sourceRevision: true,
    environment: true,
  })
  .strict()
export type ServiceCandidate = z.infer<typeof serviceCandidateSchema>

const latencyCohort = z
  .object({
    clientRegion: z.enum(["Paris", "Virginia"]),
    operation: z.enum([
      "issue-list",
      "issue-create",
      "issue-update",
      "issue-comment",
    ]),
    samples: count,
    p95Ms: duration,
  })
  .strict()

export const serviceEvidenceSchema = z.discriminatedUnion("kind", [
  base
    .extend({
      kind: z.literal("load"),
      steadySeconds: duration,
      warmupSeconds: duration,
      burstSeconds: duration,
      burstRequestsPerSecond: count,
      achievedRequestsPerSecond: duration,
      droppedIterations: count,
      latency: z.array(latencyCohort),
      notificationSamples: count.positive(),
      notificationMaxSeconds: duration,
      /** References cover cold start/redeploy, overload, failure and replay cases. */
      failureExercises: artifact,
    })
    .strict(),
  base
    .extend({
      kind: z.literal("availability"),
      operations: z
        .object(
          Object.fromEntries(
            coreOperations.map((operation) => [operation, requestResult])
          )
        )
        .strict(),
    })
    .strict(),
  base
    .extend({
      kind: z.literal("recovery"),
      incidentStartedAt: z.iso.datetime(),
      validatedServiceRestoredAt: z.iso.datetime(),
      dataLossSeconds: z
        .object({
          database: duration,
          objects: duration,
          deletionJournal: duration,
        })
        .strict(),
      /** Includes keys, schema/checksums, journal replay and authorized smoke tests. */
      reconciliation: artifact,
    })
    .strict(),
])

export type ServiceEvidence = z.infer<typeof serviceEvidenceSchema>
export type EvidenceAssessment = {
  status: "insufficient-evidence" | "budget-failed" | "eligible-for-review"
  problems: Array<string>
}

/** Use only with trusted QA artifacts. Eligibility is not release approval or
 * authentication of measurements, candidate identity or stakeholder acceptance. */
export function assessServiceEvidence(
  raw: unknown,
  candidate: ServiceCandidate
): EvidenceAssessment {
  const parsed = serviceEvidenceSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      status: "insufficient-evidence",
      problems: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "evidence"}: ${issue.message}`
      ),
    }
  }
  const evidence = parsed.data
  const problems: Array<string> = []
  const expected = serviceCandidateSchema.safeParse(candidate)
  if (!expected.success) {
    return {
      status: "insufficient-evidence",
      problems: [
        "Missing or invalid independently recorded candidate identity",
      ],
    }
  }
  if (evidence.sourceRevision !== expected.data.sourceRevision)
    problems.push("Source revision does not match the candidate")
  for (const [key, value] of Object.entries(expected.data.environment)) {
    const actual =
      evidence.environment[key as keyof typeof evidence.environment]
    const matches =
      typeof value === "string"
        ? actual === value
        : Object.entries(value).every(
            ([field, entry]) =>
              (actual as Record<string, string>)[field] === entry
          )
    if (!matches) problems.push(`Candidate environment mismatch: ${key}`)
  }
  for (const [section, decision] of Object.entries(serviceObjectiveDecisions)) {
    if (decision.status !== "accepted")
      problems.push(`${section} is not accepted`)
  }
  const start = Date.parse(evidence.startedAt)
  const end = Date.parse(evidence.endedAt)
  if (end <= start) problems.push("Evidence window must have positive duration")
  for (const [key, value] of Object.entries(serviceWorkload)) {
    if (evidence.workload.dimensions[key] !== value)
      problems.push(`Workload mismatch: ${key}`)
  }
  for (const [key, value] of Object.entries(serviceRegions)) {
    if (
      evidence.environment.regions[key as keyof typeof serviceRegions] !== value
    )
      problems.push(`Region mismatch: ${key}`)
  }

  if (evidence.kind === "load") {
    if (
      evidence.warmupSeconds < 600 ||
      evidence.steadySeconds < 3_600 ||
      evidence.burstSeconds < 300 ||
      evidence.burstRequestsPerSecond !== 100 ||
      end - start <
        (evidence.warmupSeconds +
          evidence.steadySeconds +
          evidence.burstSeconds) *
          1_000
    )
      problems.push("Incomplete warm-up, steady or burst observation")
    for (const region of ["Paris", "Virginia"] as const) {
      for (const operation of [
        "issue-list",
        "issue-create",
        "issue-update",
        "issue-comment",
      ] as const) {
        const cohorts = evidence.latency.filter(
          (row) => row.clientRegion === region && row.operation === operation
        )
        if (cohorts.length !== 1 || cohorts[0].samples < 1_000)
          problems.push(
            `Missing, duplicate or undersampled cohort: ${region}/${operation}`
          )
      }
    }
  }
  if (
    evidence.kind === "availability" &&
    end - start !== serviceTargets.availabilityWindowSeconds * 1_000
  )
    problems.push(
      "Availability aggregate must cover exactly one rolling seven-day window"
    )
  if (evidence.kind === "recovery") {
    const incident = Date.parse(evidence.incidentStartedAt)
    const restored = Date.parse(evidence.validatedServiceRestoredAt)
    if (incident < start || restored < incident || restored > end)
      problems.push(
        "Recovery timestamps are inconsistent with the evidence window"
      )
  }
  if (problems.length) return { status: "insufficient-evidence", problems }

  if (evidence.kind === "load") {
    if (
      evidence.droppedIterations > 0 ||
      evidence.achievedRequestsPerSecond < serviceWorkload.requestsPerSecond
    )
      problems.push("Offered load was dropped or not achieved")
    for (const cohort of evidence.latency) {
      const limit =
        cohort.operation === "issue-list"
          ? serviceTargets.listP95Ms
          : serviceTargets.writeP95Ms
      if (cohort.p95Ms > limit)
        problems.push(
          `Latency budget exceeded: ${cohort.clientRegion}/${cohort.operation}`
        )
    }
    if (evidence.notificationMaxSeconds > serviceTargets.notificationMaxSeconds)
      problems.push("Notification delivery budget exceeded")
  } else if (evidence.kind === "availability") {
    for (const [operation, result] of Object.entries(evidence.operations)) {
      if (
        1 - result.failures / result.attempts <
        serviceTargets.coreSuccessRatio
      )
        problems.push(`Core success budget failed: ${operation}`)
    }
  } else {
    if (
      Object.values(evidence.dataLossSeconds).some(
        (loss) => loss > serviceTargets.recoveryPointSeconds
      )
    )
      problems.push("Recovery point budget exceeded")
    if (
      Date.parse(evidence.validatedServiceRestoredAt) -
        Date.parse(evidence.incidentStartedAt) >
      serviceTargets.recoveryTimeSeconds * 1_000
    )
      problems.push("Recovery time budget exceeded")
  }
  return {
    status: problems.length ? "budget-failed" : "eligible-for-review",
    problems,
  }
}
