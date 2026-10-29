# Agent provider, spending and execution policy v1

FOR-75 decision and evidence contract, accepted 29 October 2026. The user confirmed
all built-in providers and unlimited run concurrency on 28 October, and accepted
the execution, disconnect, sandbox and unknown-pricing rules on 29 October.
`AGENT_EXECUTION_POLICY_VERSION = 1` identifies this contract. Changed policy
requires a new accepted version; deployment defaults are not policy approval.

## Eligibility and accounting

Every run requires current workspace membership, credential scopes, model/connection
access and the workspace's agent permission. The server resolves and persists its
payer from the trusted connection. Browser events cannot select their payer.

| Mode                                                               | Eligibility                                                                                                                                                                                                       | Customer allowance and overage                                                                                        | Concurrency                                                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Forge-funded built-in provider                                     | OpenAI, Anthropic, Google, MiniMax, Mistral, xAI, DeepSeek and Kimi are in scope. Each model needs current credentials, a verified positive maximum-cost quote, durable ownership and deployed provider evidence. | Workspace AI pool, then explicitly authorized capped paid overage at provider cost with no markup.                    | No user, workspace or global-provider run-count cap.                                            |
| BYOK (`pay-as-you-go`)                                             | Authorized customer key and verified execution/connection path, including supported custom endpoints.                                                                                                             | Customer pays the provider directly; excluded from Forge pool and overage. Retain provider-cost telemetry separately. | Same unlimited run-count policy.                                                                |
| Provider subscription or token plan (`subscription`, `token-plan`) | Authorized provider-owned access and verified execution ownership. External agents must be local-only and owned by the customer's local process.                                                                  | Customer pays the provider directly; excluded from Forge pool and overage.                                            | Same unlimited run-count policy.                                                                |
| Forge-funded custom endpoint                                       | Disabled: no accepted custom funding policy, even if a price is supplied.                                                                                                                                         | No automatic zero-cost/free classification.                                                                           | No cap is used as a substitute for funding eligibility.                                         |
| Unknown provider, payer, pricing or execution owner                | Unknown provider/payer/owner is ineligible. Unknown Forge-funded pricing stays disabled until reconciled. Customer-paid unknown pricing is provider-direct, never an assertion of zero provider cost.             | Missing historical payer/cost requires reconciliation before invoicing.                                               | Provider throttling and outages are execution failures, not new Forge concurrency entitlements. |

There is no global-provider spending pool or invented cross-customer monetary cap.
Every funded run reserves its bounded cost against its workspace. Optional existing
user/workspace UTC-calendar operational spend caps are additional controls and do
not reset, replace or grant the commercial allowance. Retired
`FORGE_AGENT_*_CONCURRENT_RUNS` variables remain ignored.

The existing [plan matrix](forge-plan-matrix.md), [usage ledger](workspace-usage-ledger.md)
and billing helpers remain authoritative for commercial arithmetic:

- Free: fixed US$5 per workspace per signup-anniversary month, independent of seats.
- Trial: one fixed US$5 workspace pool for the original 14-day window, once per
  workspace. Calls and Signals use this pool. No refill on month boundaries.
- Starter/Plus: US$5 per current active member, pooled per workspace billing
  anniversary. Agent usage consumes it; paid Calls/Signals outside trial do not.
- Free/trial never permit overage. Paid overage defaults off and requires current
  owner/admin opt-in, a separate finite monthly cap and verified payment authority.
  Currency/FX authority is separate from USD provider-cost accounting.
- Admission includes settled spend, outstanding reservations and the proposed
  reservation, under one transaction. Seat removal cannot erase committed spend.
  Transitions preserve their accepted carryover/fresh-first-paid rules.
- Cancellation, timeout, disconnect or unknown provider outcome cannot silently
  release committed exposure. Reconcile actual charges, retain uncertain holds,
  record late/above-bound cost truthfully and never invoice unknown cost as zero.

## Accepted execution bounds and authority

All plans, trial phases and provider modes use a maximum **15-minute original run
deadline**, **200,000 input tokens** and **50,000 output tokens**. Operators may lower
these values; `resolveAgentControlPolicy` clamps environment overrides to the
accepted maximum. Provider limits may be stricter. Reconnects, retries, redeploys
and approval waits do not restart the deadline or token counters. A quote must
bound the entire run, including all model calls; per-call token limits alone are
not a total cost guarantee.

Closing a browser or losing its event stream does not cancel the execution.
Reconnect attaches to the same durable owner and persisted event cursor. Explicit
cancellation and deadline expiry stop further effects, propagate cancellation and
settle only confirmed usage. An ambiguous funded call is never automatically
reissued. FOR-77/78 own durable implementation and failure/redeploy verification.

Capabilities must be registered, enabled, scoped and authorized for the current
actor/resource. Writes require their existing approval and idempotency rules.
A stronger model, funded balance or sandbox does not grant additional authority.
Undeclared capabilities remain unavailable; admin allowlists can narrow access.

Code requires an **isolated hosted sandbox with deny-all network**, no Forge or
DB credentials, bounded inputs and teardown. Automatic development backend
selection is not proof of hosted isolation. Local provider processes do not
qualify as hosted code sandboxes: keep code unavailable there unless the isolated
hosted path is independently verified. The exact hosted backend remains a
candidate-specific implementation choice under this accepted isolation contract;
unknown or unverified backends remain disabled. FOR-85 owns deployed isolation
and provider evidence.

## Executable production evidence contract

`agentProviderPolicy` provides the mode/provider matrix. `assessAgentPolicyEvidence`
qualifies one provider/model/payer/execution route for the exact source revision,
environment and web/runtime deployment IDs in an independently recorded candidate.
It returns `disabled`, `insufficient-evidence` or `eligible-for-review`.

An enabled route must supply policy v1, operator/time/configuration provenance,
accepted limits, known compatible execution ownership and deployed evidence with
checksummed artifacts for current authorization, scoped/approved capabilities,
credentials/revocation, live provider execution, original deadline/token bounds,
single ownership across disconnect/reconnect and cancellation/reconciliation.
Code additionally requires sandbox-isolation proof; funded usage additionally
requires positive bounded pricing, a quote valid at the observation time and
atomic reservation/settlement proof.
Duplicate, missing, failed or unrun checks fail qualification. Fixture evidence,
changed candidate identity, old versions, unknown funded prices/owners and limits
above the accepted maximum fail qualification.

Run the offline checker once for each intended provider/model/payer route:

```sh
bun run agent:policy:check candidate.json evidence.json
```

Both files follow the exported strict Zod schemas in
`apps/forge/src/application/agents/agent-execution-policy.ts`. The candidate records
`sourceRevision`, `environment` (`name`, `webDeploymentId`, `runtimeDeploymentId`),
`provider`, `modelId`, `billingMode`, `executionKind` and `locality`. A disabled
artifact contains those same fields, `policyVersion: 1`, `enabled: false` and a
nonempty `reason`. Enabled artifacts require all additional evidence fields; the
unit fixtures demonstrate the shape but cannot certify production. The checker
is read-only, loads no credentials and exits nonzero for insufficient evidence.
Disabled is an explicit release exclusion; it is not implementation completion.

The checker does not authenticate artifacts or operate a runtime feature flag.
Only trusted QA artifacts can support review. A passing schema or claimed check
is not release approval. Actual enablement must keep unqualified routes disabled
and integrate this contract at trusted quote/dispatch boundaries.

## Completion boundary

FOR-75 completes the accepted decision, matrix, shared bounds and offline
qualification contract. AT-01 exercises every supported provider/payer combination
and the existing allowance/period tests. AT-02 covers disabled and bounded routes,
unknown pricing/ownership, malformed/mismatched evidence and the real checker CLI.

No production model calls, charges, database migrations or feature enablement are
performed by this work. The existing coordinator is not certified for an original
deadline across approval waits/redeploys, atomic funding or independent browser
ownership. FOR-76 retains quote sourcing, atomic runtime admission/dispatch and
settlement integration; FOR-77/78 retain durable ownership/cancellation/deadlines;
FOR-85/148 retain per-provider, credential and hosted isolation verification. These
remain release blockers for their routes, even after FOR-75 is Done. The all-provider
scope is eligibility, not a claim that every funded provider has been provisioned.
