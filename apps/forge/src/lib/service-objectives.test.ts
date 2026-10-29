import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  assessServiceEvidence,
  serviceObjectiveDecisions,
  serviceRegions,
  serviceWorkload,
} from "./service-objectives"
import type { ServiceCandidate, ServiceEvidence } from "./service-objectives"

const artifact = { reference: "fixture-artifact.json", sha256: "a".repeat(64) }
const candidate: ServiceCandidate = {
  sourceRevision: "b".repeat(40),
  environment: {
    name: "isolated-test-fixture",
    webDeploymentId: "fixture-web",
    runtimeDeploymentId: "fixture-runtime",
    databaseIdentity: "fixture-project/branch/database",
    schemaFingerprint: "c".repeat(64),
    storageIdentity: "fixture-private-store",
    configuration: artifact,
    regions: { ...serviceRegions },
  },
}
function load(): ServiceEvidence & { kind: "load" } {
  return {
    ...structuredClone(candidate),
    objectiveVersion: 1,
    workloadId: "launch-v1",
    operator: "synthetic QA fixture",
    startedAt: "2026-10-29T10:00:00Z",
    endedAt: "2026-10-29T11:15:00Z",
    rawMeasurements: artifact,
    exclusions: artifact,
    workload: {
      manifest: artifact,
      runnerRevision: "d".repeat(40),
      dimensions: { ...serviceWorkload },
    },
    kind: "load",
    steadySeconds: 3_600,
    warmupSeconds: 600,
    burstSeconds: 300,
    burstRequestsPerSecond: 100,
    achievedRequestsPerSecond: 50,
    droppedIterations: 0,
    latency: (["Paris", "Virginia"] as const).flatMap((clientRegion) =>
      (
        ["issue-list", "issue-create", "issue-update", "issue-comment"] as const
      ).map((operation) => ({
        clientRegion,
        operation,
        samples: 1_000,
        p95Ms: operation === "issue-list" ? 500 : 1_000,
      }))
    ),
    notificationSamples: 6_000,
    notificationMaxSeconds: 60,
    failureExercises: artifact,
  }
}
function availability(): ServiceEvidence & { kind: "availability" } {
  const {
    kind: _kind,
    steadySeconds: _steady,
    warmupSeconds: _warmup,
    burstSeconds: _burst,
    burstRequestsPerSecond: _burstRate,
    achievedRequestsPerSecond: _achieved,
    droppedIterations: _dropped,
    latency: _latency,
    notificationSamples: _samples,
    notificationMaxSeconds: _max,
    failureExercises: _exercises,
    ...common
  } = load()
  return {
    ...common,
    kind: "availability",
    endedAt: "2026-11-05T10:00:00Z",
    operations: Object.fromEntries(
      [
        "auth-session",
        "issue-list",
        "issue-get",
        "issue-create",
        "issue-update",
        "issue-comment",
        "workspace-team-read",
      ].map((operation) => [operation, { attempts: 10_000, failures: 50 }])
    ),
  }
}
function recovery(): ServiceEvidence & { kind: "recovery" } {
  const { kind: _kind, operations: _operations, ...common } = availability()
  return {
    ...common,
    kind: "recovery",
    endedAt: "2026-10-29T14:00:00Z",
    incidentStartedAt: "2026-10-29T10:00:00Z",
    validatedServiceRestoredAt: "2026-10-29T14:00:00Z",
    dataLossSeconds: { database: 3_600, objects: 3_600, deletionJournal: 0 },
    reconciliation: artifact,
  }
}

const actualDecisions = structuredClone(serviceObjectiveDecisions)
beforeEach(() => {
  // Fixture approval only; this is not stakeholder acceptance of the real sheet.
  for (const decision of Object.values(serviceObjectiveDecisions))
    decision.status = "accepted"
})
afterEach(() =>
  Object.assign(serviceObjectiveDecisions, structuredClone(actualDecisions))
)
const assess = (input: unknown) => assessServiceEvidence(input, candidate)

describe("FOR-24 AC-01/AT-01: versioned and accepted objectives", () => {
  it.each([load, availability, recovery])(
    "permits boundary measurements for review with complete fixture evidence",
    (fixture) => {
      expect(assess(fixture())).toEqual({
        status: "eligible-for-review",
        problems: [],
      })
    }
  )
  it.each(["targets", "workloadAndMeasurements", "capacity"] as const)(
    "refuses unaccepted %s",
    (section) => {
      serviceObjectiveDecisions[section].status = "proposed"
      expect(assess(load()).status).toBe("insufficient-evidence")
    }
  )
  it("refuses a different objective version, workload or source revision", () => {
    for (const patch of [
      { objectiveVersion: 2 },
      { workloadId: "unknown" },
      { sourceRevision: "e".repeat(40) },
    ])
      expect(assess({ ...load(), ...patch }).status).toBe(
        "insufficient-evidence"
      )
  })
})

describe("FOR-24 AC-02/AT-02: incomplete performance evidence is rejected", () => {
  it.each([
    "workload",
    "environment",
    "sourceRevision",
    "operator",
    "rawMeasurements",
    "exclusions",
  ])("rejects missing %s", (field) => {
    const input: Record<string, unknown> = { ...load() }
    delete input[field]
    expect(assess(input).status).toBe("insufficient-evidence")
  })
  it("rejects missing dataset dimensions, counts and region mismatches", () => {
    const input = load()
    delete input.workload.dimensions.issues
    expect(assess(input).status).toBe("insufficient-evidence")
    input.workload.dimensions.issues = 1
    expect(assess(input).status).toBe("insufficient-evidence")
    input.workload.dimensions.issues = serviceWorkload.issues
    input.environment.regions.database = "unknown"
    expect(assess(input).status).toBe("insufficient-evidence")
  })
  it("rejects stale deployment, schema, storage and configuration identities", () => {
    for (const field of [
      "webDeploymentId",
      "runtimeDeploymentId",
      "schemaFingerprint",
      "storageIdentity",
    ] as const) {
      const input = load()
      input.environment[field] = "e".repeat(64)
      expect(assess(input).status).toBe("insufficient-evidence")
    }
    const input = load()
    input.environment.configuration = { ...artifact, sha256: "f".repeat(64) }
    expect(assess(input).status).toBe("insufficient-evidence")
    expect(assessServiceEvidence(load(), {} as ServiceCandidate).status).toBe(
      "insufficient-evidence"
    )
  })
  it("rejects short observation, absent regions, duplicate or undersampled cohorts", () => {
    const short = load()
    short.endedAt = "2026-10-29T10:01:00Z"
    expect(assess(short).status).toBe("insufficient-evidence")
    const missing = load()
    missing.latency = missing.latency.filter(
      (row) => row.clientRegion !== "Virginia"
    )
    expect(assess(missing).status).toBe("insufficient-evidence")
    const duplicate = load()
    duplicate.latency.push(duplicate.latency[0])
    expect(assess(duplicate).status).toBe("insufficient-evidence")
    const undersampled = load()
    undersampled.latency[0].samples = 999
    expect(assess(undersampled).status).toBe("insufficient-evidence")
  })
  it.each([-1, NaN, Infinity])("rejects invalid measurement %s", (value) => {
    const input = load()
    input.latency[0].p95Ms = value
    expect(assess(input).status).toBe("insufficient-evidence")
  })
  it("rejects a shorter/longer availability aggregate or impossible request totals", () => {
    const input = availability()
    input.endedAt = "2026-10-29T11:00:00Z"
    expect(assess(input).status).toBe("insufficient-evidence")
    input.endedAt = "2026-11-06T10:00:00Z"
    expect(assess(input).status).toBe("insufficient-evidence")
    input.endedAt = "2026-11-05T10:00:00Z"
    input.operations["issue-create"].failures = 10_001
    expect(assess(input).status).toBe("insufficient-evidence")
  })
  it("rejects inconsistent recovery timestamps", () => {
    const input = recovery()
    input.incidentStartedAt = "2026-10-29T15:00:00Z"
    expect(assess(input).status).toBe("insufficient-evidence")
  })
})

describe("budget failures cannot become release evidence", () => {
  it.each(["issue-list", "issue-create", "issue-update", "issue-comment"])(
    "checks %s in each client region",
    (operation) => {
      const input = load()
      const cohort = input.latency.find(
        (row) => row.clientRegion === "Virginia" && row.operation === operation
      )!
      cohort.p95Ms += 1
      expect(assess(input).status).toBe("budget-failed")
    }
  )
  it("fails notification age, dropped iterations and underachieved load", () => {
    for (const patch of [
      { notificationMaxSeconds: 61 },
      { droppedIterations: 1 },
      { achievedRequestsPerSecond: 49 },
    ])
      expect(assess({ ...load(), ...patch }).status).toBe("budget-failed")
  })
  it("fails low-volume operation errors even with many successful reads", () => {
    const input = availability()
    input.operations["issue-list"] = { attempts: 1_000_000, failures: 0 }
    input.operations["issue-create"] = { attempts: 1_000, failures: 6 }
    expect(assess(input).status).toBe("budget-failed")
  })
  it.each(["database", "objects", "deletionJournal"] as const)(
    "checks RPO for %s",
    (store) => {
      const input = recovery()
      input.dataLossSeconds[store] = 3_601
      expect(assess(input).status).toBe("budget-failed")
    }
  )
  it("includes detection and validation time in RTO", () => {
    const input = recovery()
    input.endedAt = "2026-10-29T14:00:01Z"
    input.validatedServiceRestoredAt = input.endedAt
    expect(assess(input).status).toBe("budget-failed")
  })
})

describe("FOR-24 AC-03/AT-03: capacity policy cannot be implicitly accepted", () => {
  it("refuses otherwise complete evidence with unaccepted capacity choices", () => {
    serviceObjectiveDecisions.capacity.status = "proposed"
    expect(assess(load()).problems).toContain("capacity is not accepted")
  })
  it("does not alter the evidence or approved candidate", () => {
    const input = load()
    const before = structuredClone({ input, candidate })
    assess(input)
    expect({ input, candidate }).toEqual(before)
  })
})

describe("offline evidence submission command", () => {
  function submit(evidence: Array<unknown>) {
    const directory = mkdtempSync(join(tmpdir(), "forge-objectives-"))
    try {
      const paths = [candidate, ...evidence].map((value, index) => {
        const path = join(directory, `${index}.json`)
        writeFileSync(path, JSON.stringify(value))
        return path
      })
      return spawnSync(
        "bun",
        [
          resolve(
            dirname(fileURLToPath(import.meta.url)),
            "../../scripts/check-service-objectives.ts"
          ),
          ...paths,
        ],
        { encoding: "utf8" }
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  it("accepts a complete synthetic set for review against the accepted sheet", () => {
    const result = submit([load(), availability(), recovery()])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.match(/eligible-for-review/g)).toHaveLength(3)
  })

  it("rejects submitted performance evidence without workload or environment", () => {
    for (const field of ["workload", "environment"]) {
      const incomplete: Record<string, unknown> = { ...load() }
      delete incomplete[field]
      const result = submit([incomplete, availability(), recovery()])
      expect(result.status, result.stderr).toBe(1)
      expect(result.stdout).toContain("insufficient-evidence")
    }
  })

  it("rejects a duplicate kind in place of recovery evidence", () => {
    const result = submit([load(), availability(), load()])
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain(
      "Exactly one load, availability and recovery"
    )
  })
})
