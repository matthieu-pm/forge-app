import { z } from "zod"
import { MODEL_BILLING_MODES, MODEL_EXECUTION_KINDS } from "./model-contract"
import { MODEL_PROVIDERS } from "./model-connection-contract"

/** FOR-75 decision/evidence contract. This does not dispatch or fund a run. */
export const AGENT_EXECUTION_POLICY_VERSION = 1
export const agentExecutionPolicy = {
  status: "accepted",
  acceptedAt: "2026-10-29",
  runWallClockMs: 15 * 60_000,
  maxInputTokens: 200_000,
  maxOutputTokens: 50_000,
  concurrency: { user: null, workspace: null, provider: null },
  disconnect: "continue-same-execution",
  cancellation: "explicit-with-confirmed-settlement",
  deadline: "original-run-including-approval-waits-and-reconnects",
  sandbox: "isolated-hosted-deny-network",
  capabilities: "registered-authorized-and-approved-writes",
  unknownFundedPricing: "disabled-until-reconciled",
} as const

export const FUNDED_AGENT_PROVIDERS = MODEL_PROVIDERS.filter(
  (provider) => !provider.startsWith("custom-")
)

/** Inputs are trusted connection/catalog snapshots, never client payer flags. */
export function agentProviderPolicy(input: {
  provider: unknown
  billingMode: unknown
}) {
  const provider = z.enum(MODEL_PROVIDERS).parse(input.provider)
  const billingMode = z.enum(MODEL_BILLING_MODES).parse(input.billingMode)
  const funded = billingMode === "forge-managed"
  return {
    eligible: !funded || FUNDED_AGENT_PROVIDERS.includes(provider),
    payer: funded ? ("forge" as const) : ("customer-provider" as const),
    allowance: funded ? ("workspace-ai-pool" as const) : ("excluded" as const),
    overage: funded
      ? ("explicit-capped-at-cost" as const)
      : ("excluded" as const),
    pricing: funded
      ? ("bounded-verified-quote" as const)
      : ("provider-direct" as const),
    concurrency: agentExecutionPolicy.concurrency,
  }
}

const label = z.string().trim().min(1).max(1000)
const sha = z.string().regex(/^[a-f0-9]{40}$/)
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
const artifact = z.strictObject({ reference: label, sha256: fingerprint })
export const agentPolicyCandidateSchema = z.strictObject({
  sourceRevision: sha,
  environment: z.strictObject({
    name: label,
    webDeploymentId: label,
    runtimeDeploymentId: label,
  }),
  provider: z.enum(MODEL_PROVIDERS),
  modelId: label,
  billingMode: z.enum(MODEL_BILLING_MODES),
  executionKind: z.enum(MODEL_EXECUTION_KINDS),
  locality: z.enum(["server-capable", "local-only"]),
})
export type AgentPolicyCandidate = z.infer<typeof agentPolicyCandidateSchema>

export const AGENT_POLICY_CHECKS = [
  "current-authorization",
  "capability-scopes-and-write-approvals",
  "provider-credentials-and-revocation",
  "provider-release",
  "original-deadline-and-token-bounds",
  "disconnect-reconnect-single-owner",
  "cancel-and-unknown-outcome-reconciliation",
  "sandbox-isolation",
  "atomic-allowance-reservation-and-settlement",
] as const
const check = z.strictObject({
  name: z.enum(AGENT_POLICY_CHECKS),
  result: z.enum(["passed", "failed", "not-run"]),
  artifact,
})
const pricing = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("unknown") }),
  z.strictObject({
    status: z.literal("verified-bound"),
    maximumCostUsdMicros: z.number().int().positive().safe(),
    fingerprint,
    validFrom: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    artifact,
  }),
])
const base = agentPolicyCandidateSchema.extend({
  policyVersion: z.literal(AGENT_EXECUTION_POLICY_VERSION),
})
export const agentPolicyEvidenceSchema = z.discriminatedUnion("enabled", [
  base.extend({ enabled: z.literal(false), reason: label }).strict(),
  base
    .extend({
      enabled: z.literal(true),
      kind: z.enum(["deployed", "fixture"]),
      operator: label,
      observedAt: z.iso.datetime(),
      configuration: artifact,
      executionOwner: z.enum([
        "durable-runtime",
        "durable-worker",
        "local-process",
        "unknown",
      ]),
      limits: z.strictObject({
        runWallClockMs: z
          .number()
          .int()
          .positive()
          .max(agentExecutionPolicy.runWallClockMs),
        maxInputTokens: z
          .number()
          .int()
          .positive()
          .max(agentExecutionPolicy.maxInputTokens),
        maxOutputTokens: z
          .number()
          .int()
          .positive()
          .max(agentExecutionPolicy.maxOutputTokens),
      }),
      codeEnabled: z.boolean(),
      sandbox: z.enum([
        "isolated-hosted-deny-network",
        "local-process",
        "unknown",
        "disabled",
      ]),
      pricing,
      checks: z.array(check),
    })
    .strict(),
])

type Assessment = {
  status: "disabled" | "insufficient-evidence" | "eligible-for-review"
  problems: Array<string>
}

/** Offline qualification of trusted QA evidence, not proof of its authenticity
 * or permission to enable a deployment. Call for every provider/model/payer route. */
export function assessAgentPolicyEvidence(
  raw: unknown,
  expected: AgentPolicyCandidate
): Assessment {
  const candidate = agentPolicyCandidateSchema.safeParse(expected)
  const parsed = agentPolicyEvidenceSchema.safeParse(raw)
  if (!candidate.success || !parsed.success) {
    return {
      status: "insufficient-evidence",
      problems: ["Invalid or missing candidate/policy evidence"],
    }
  }
  const evidence = parsed.data
  const problems: Array<string> = []
  for (const key of [
    "sourceRevision",
    "provider",
    "modelId",
    "billingMode",
    "executionKind",
    "locality",
  ] as const) {
    if (evidence[key] !== candidate.data[key])
      problems.push(`Candidate ${key} mismatch`)
  }
  for (const key of [
    "name",
    "webDeploymentId",
    "runtimeDeploymentId",
  ] as const) {
    if (evidence.environment[key] !== candidate.data.environment[key])
      problems.push(`Candidate environment ${key} mismatch`)
  }
  if (problems.length) return { status: "insufficient-evidence", problems }
  if (!evidence.enabled) return { status: "disabled", problems: [] }

  const policy = agentProviderPolicy(evidence)
  if (!policy.eligible)
    problems.push(
      "Custom Forge-funded providers have no accepted funding policy"
    )
  if (evidence.kind !== "deployed")
    problems.push("Fixture evidence cannot enable production")
  if (evidence.executionKind === "forge-native") {
    if (
      evidence.locality !== "server-capable" ||
      !["durable-runtime", "durable-worker"].includes(evidence.executionOwner)
    ) {
      problems.push("Hosted runs require a durable execution owner")
    }
  } else if (
    evidence.locality !== "local-only" ||
    evidence.executionOwner !== "local-process" ||
    policy.payer === "forge"
  ) {
    problems.push(
      "External agents require customer-paid local execution ownership"
    )
  }
  if (
    evidence.codeEnabled &&
    evidence.sandbox !== agentExecutionPolicy.sandbox
  ) {
    problems.push(
      "Code requires an isolated hosted sandbox with deny-all network"
    )
  }
  if (
    policy.payer === "forge" &&
    evidence.pricing.status !== "verified-bound"
  ) {
    problems.push(
      "Forge-funded usage requires a verified positive bounded quote"
    )
  }
  if (evidence.pricing.status === "verified-bound") {
    const observed = Date.parse(evidence.observedAt)
    if (
      observed < Date.parse(evidence.pricing.validFrom) ||
      observed >= Date.parse(evidence.pricing.expiresAt)
    ) {
      problems.push(
        "Pricing quote is not valid at the evidence observation time"
      )
    }
  }
  const required = AGENT_POLICY_CHECKS.filter(
    (name) =>
      (name !== "sandbox-isolation" || evidence.codeEnabled) &&
      (name !== "atomic-allowance-reservation-and-settlement" ||
        policy.payer === "forge")
  )
  const names = new Set<string>()
  for (const result of evidence.checks) {
    if (names.has(result.name)) problems.push(`Duplicate check: ${result.name}`)
    names.add(result.name)
    if (result.result !== "passed")
      problems.push(`Unverified check: ${result.name}`)
  }
  for (const name of required) {
    if (!names.has(name)) problems.push(`Missing check: ${name}`)
  }
  return {
    status: problems.length ? "insufficient-evidence" : "eligible-for-review",
    problems,
  }
}
