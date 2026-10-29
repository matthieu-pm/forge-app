// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import {
  AGENT_EXECUTION_POLICY_VERSION,
  AGENT_POLICY_CHECKS,
  FUNDED_AGENT_PROVIDERS,
  agentExecutionPolicy,
  agentProviderPolicy,
  assessAgentPolicyEvidence,
} from "./agent-execution-policy"
import { MODEL_PROVIDERS } from "./model-connection-contract"
import { MODEL_BILLING_MODES } from "./model-contract"

const artifact = {
  reference: "qa/provider-report.json",
  sha256: "b".repeat(64),
}
const candidate = {
  sourceRevision: "a".repeat(40),
  environment: {
    name: "candidate",
    webDeploymentId: "web-1",
    runtimeDeploymentId: "runtime-1",
  },
  provider: "openai" as const,
  modelId: "test-model",
  billingMode: "forge-managed" as const,
  executionKind: "forge-native" as const,
  locality: "server-capable" as const,
}
function evidence() {
  return {
    ...candidate,
    policyVersion: AGENT_EXECUTION_POLICY_VERSION,
    enabled: true,
    kind: "deployed",
    operator: "qa",
    observedAt: "2026-10-29T20:00:00Z",
    configuration: artifact,
    executionOwner: "durable-runtime",
    limits: {
      runWallClockMs: 900_000,
      maxInputTokens: 200_000,
      maxOutputTokens: 50_000,
    },
    codeEnabled: true,
    sandbox: "isolated-hosted-deny-network",
    pricing: {
      status: "verified-bound",
      maximumCostUsdMicros: 1_000_000,
      fingerprint: "c".repeat(64),
      validFrom: "2026-10-29T19:00:00Z",
      expiresAt: "2026-10-29T21:00:00Z",
      artifact,
    },
    checks: AGENT_POLICY_CHECKS.map((name) => ({
      name,
      result: "passed",
      artifact,
    })),
  }
}
const assess = (raw: unknown) => assessAgentPolicyEvidence(raw, candidate)
const rejected = (raw: unknown) =>
  expect(assess(raw).status).toBe("insufficient-evidence")

describe("FOR-75 provider eligibility and accounting (AT-01)", () => {
  it.each(
    MODEL_PROVIDERS.flatMap((provider) =>
      MODEL_BILLING_MODES.map((billingMode) => ({ provider, billingMode }))
    )
  )(
    "$provider / $billingMode has an explicit payer, allowance and concurrency policy",
    (input) => {
      const policy = agentProviderPolicy(input)
      const funded = input.billingMode === "forge-managed"
      expect(policy.eligible).toBe(
        !funded || !input.provider.startsWith("custom-")
      )
      expect(policy.payer).toBe(funded ? "forge" : "customer-provider")
      expect(policy.allowance).toBe(funded ? "workspace-ai-pool" : "excluded")
      expect(policy.overage).toBe(
        funded ? "explicit-capped-at-cost" : "excluded"
      )
      expect(policy.concurrency).toEqual({
        user: null,
        workspace: null,
        provider: null,
      })
    }
  )
  it.each([
    { provider: "unknown", billingMode: "forge-managed" },
    { provider: "openai", billingMode: "unknown" },
    { provider: "openai", billingMode: undefined },
  ])("rejects unknown classification %o", (input) => {
    expect(() => agentProviderPolicy(input)).toThrow()
  })
  it("records the accepted disconnect, deadline, sandbox and capability decisions", () => {
    expect(agentExecutionPolicy).toMatchObject({
      status: "accepted",
      disconnect: "continue-same-execution",
      deadline: "original-run-including-approval-waits-and-reconnects",
      sandbox: "isolated-hosted-deny-network",
      capabilities: "registered-authorized-and-approved-writes",
    })
  })
})

describe("FOR-75 production qualification (AT-02)", () => {
  it.each(FUNDED_AGENT_PROVIDERS)(
    "qualifies a bounded %s candidate without certifying a deployment",
    (provider) => {
      expect(
        assessAgentPolicyEvidence(
          { ...evidence(), provider },
          { ...candidate, provider }
        ).status
      ).toBe("eligible-for-review")
    }
  )
  it("accepts an explicitly disabled route without claiming completed checks", () => {
    expect(
      assess({
        ...candidate,
        policyVersion: 1,
        enabled: false,
        reason: "Pending provider verification",
      }).status
    ).toBe("disabled")
  })
  it.each(["custom-openai", "custom-anthropic"] as const)(
    "refuses funded custom provider %s even with a quote",
    (provider) => {
      expect(
        assessAgentPolicyEvidence(
          { ...evidence(), provider },
          { ...candidate, provider }
        ).status
      ).toBe("insufficient-evidence")
    }
  )
  it.each(["unknown", "local-process"])(
    "refuses hosted execution owner %s",
    (executionOwner) => rejected({ ...evidence(), executionOwner })
  )
  it.each(["local-process", "unknown", "disabled"])(
    "refuses code sandbox %s",
    (sandbox) => rejected({ ...evidence(), sandbox })
  )
  it("refuses fixture-only evidence", () =>
    rejected({ ...evidence(), kind: "fixture" }))
  it("refuses unknown funded pricing", () =>
    rejected({ ...evidence(), pricing: { status: "unknown" } }))
  it("refuses expired, premature and inverted pricing windows", () => {
    const raw = evidence()
    for (const window of [
      { validFrom: "2026-10-29T19:00:00Z", expiresAt: raw.observedAt },
      { validFrom: "2026-10-29T21:00:00Z", expiresAt: "2026-10-29T22:00:00Z" },
      { validFrom: "2026-10-29T21:00:00Z", expiresAt: "2026-10-29T19:00:00Z" },
    ])
      rejected({ ...raw, pricing: { ...raw.pricing, ...window } })
  })
  it.each([
    { sourceRevision: "d".repeat(40) },
    { provider: "anthropic" as const },
    { billingMode: "subscription" as const },
    { executionKind: "external-agent" as const },
    { locality: "local-only" as const },
    { environment: { ...candidate.environment, name: "other" } },
    { environment: { ...candidate.environment, webDeploymentId: "web-2" } },
  ])("rejects valid evidence for a different identity %o", (change) => {
    expect(
      assessAgentPolicyEvidence(evidence(), { ...candidate, ...change }).status
    ).toBe("insufficient-evidence")
  })
  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1, 0.5, null])(
    "refuses invalid or zero funded bound %s",
    (maximumCostUsdMicros) => {
      const raw = evidence()
      rejected({ ...raw, pricing: { ...raw.pricing, maximumCostUsdMicros } })
    }
  )
  it.each(["runWallClockMs", "maxInputTokens", "maxOutputTokens"] as const)(
    "refuses a raised, missing or unbounded %s",
    (key) => {
      const raw = evidence()
      for (const value of [
        raw.limits[key] + 1,
        0,
        -1,
        null,
        undefined,
        Infinity,
      ]) {
        rejected({ ...raw, limits: { ...raw.limits, [key]: value } })
      }
    }
  )
  it.each(AGENT_POLICY_CHECKS)("requires deployed proof of %s", (name) => {
    const raw = evidence()
    rejected({
      ...raw,
      checks: raw.checks.filter((check) => check.name !== name),
    })
    for (const result of ["failed", "not-run"]) {
      rejected({
        ...raw,
        checks: raw.checks.map((check) =>
          check.name === name ? { ...check, result } : check
        ),
      })
    }
  })
  it("rejects duplicate and unattested checks", () => {
    const raw = evidence()
    rejected({ ...raw, checks: [...raw.checks, raw.checks[0]] })
    rejected({
      ...raw,
      checks: raw.checks.map(({ artifact: _artifact, ...check }) => check),
    })
  })
  it.each([
    "sourceRevision",
    "provider",
    "modelId",
    "billingMode",
    "executionKind",
    "locality",
    "environment",
  ] as const)("rejects evidence copied to another candidate %s", (key) => {
    const expected = {
      ...candidate,
      [key]:
        key === "environment"
          ? { ...candidate.environment, runtimeDeploymentId: "other" }
          : "other",
    }
    expect(
      assessAgentPolicyEvidence(evidence(), expected as typeof candidate).status
    ).toBe("insufficient-evidence")
  })
  it.each(["pay-as-you-go", "token-plan", "subscription"] as const)(
    "excludes %s from Forge pricing and atomic allowance checks",
    (billingMode) => {
      const raw = {
        ...evidence(),
        billingMode,
        pricing: { status: "unknown" },
        checks: evidence().checks.filter(
          (check) =>
            check.name !== "atomic-allowance-reservation-and-settlement"
        ),
      }
      expect(
        assessAgentPolicyEvidence(raw, { ...candidate, billingMode }).status
      ).toBe("eligible-for-review")
    }
  )
  it("requires local ownership for customer-paid external agents and disallows unsandboxed code", () => {
    const route = {
      ...candidate,
      billingMode: "subscription" as const,
      executionKind: "external-agent" as const,
      locality: "local-only" as const,
    }
    const raw = {
      ...evidence(),
      ...route,
      executionOwner: "local-process",
      codeEnabled: false,
      sandbox: "disabled",
      pricing: { status: "unknown" },
      checks: evidence().checks.filter(
        (check) =>
          ![
            "sandbox-isolation",
            "atomic-allowance-reservation-and-settlement",
          ].includes(check.name)
      ),
    }
    expect(assessAgentPolicyEvidence(raw, route).status).toBe(
      "eligible-for-review"
    )
    expect(
      assessAgentPolicyEvidence(
        { ...raw, codeEnabled: true, sandbox: "local-process" },
        route
      ).status
    ).toBe("insufficient-evidence")
    expect(
      assessAgentPolicyEvidence({ ...raw, executionOwner: "unknown" }, route)
        .status
    ).toBe("insufficient-evidence")
    const funded = { ...route, billingMode: "forge-managed" as const }
    expect(
      assessAgentPolicyEvidence({ ...raw, ...funded }, funded).status
    ).toBe("insufficient-evidence")
  })
  it("rejects old policy versions, missing identities and stale concurrency fields", () => {
    rejected({ ...evidence(), policyVersion: 0 })
    rejected({ ...evidence(), configuration: undefined })
    rejected({ ...evidence(), userConcurrentRuns: 3 })
    expect(
      assessAgentPolicyEvidence(evidence(), {} as typeof candidate).status
    ).toBe("insufficient-evidence")
  })
  it("runs the read-only evidence checker on accepted, rejected and disabled artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-agent-policy-"))
    try {
      const candidatePath = join(directory, "candidate.json"),
        evidencePath = join(directory, "evidence.json")
      await writeFile(candidatePath, JSON.stringify(candidate))
      for (const [raw, exitCode, status] of [
        [evidence(), 0, "eligible-for-review"],
        [
          { ...evidence(), pricing: { status: "unknown" } },
          1,
          "insufficient-evidence",
        ],
        [
          {
            ...candidate,
            policyVersion: 1,
            enabled: false,
            reason: "Not enabled",
          },
          0,
          "disabled",
        ],
      ] as const) {
        await writeFile(evidencePath, JSON.stringify(raw))
        const result = spawnSync(
          "bun",
          ["scripts/check-agent-policy.ts", candidatePath, evidencePath],
          { encoding: "utf8" }
        )
        expect(result.status, result.stderr).toBe(exitCode)
        expect(JSON.parse(result.stdout).status).toBe(status)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
