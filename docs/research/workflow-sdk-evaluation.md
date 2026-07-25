# Workflow SDK evaluation for Forge

Research date: 2026-07-25. Sources are limited to the Workflow SDK, Vercel, Eve,
GitHub, and npm first-party documentation and metadata.

## Verdict

**Yes, but Forge already uses it.** Forge's pinned `eve@0.27.1` runtime makes
every agent turn a durable Workflow SDK workflow. Its published package bundles
the Workflow SDK 5 beta line. Adding `workflow` directly to Forge's agent path
would therefore create a second orchestration layer without adding a missing
agent capability.

A direct dependency could still be useful for **non-agent application
automations** that must survive deploys, sleep for days, or wait for an external
event—for example, staged project imports, scheduled digests, multi-system
onboarding, or approval-driven publishing. It should not replace EVE, Forge's
capability gateway, approval policy, or canonical product event store.

Recommendation:

1. Do not add Workflow SDK directly for agent runs.
2. Treat EVE as Forge's supported Workflow SDK integration point; upgrade or
   configure EVE when Forge needs newer durability features.
3. Consider a separate proof of concept only when Forge has a concrete
   long-lived **business workflow** outside the agent loop. Give that subsystem
   explicit ownership, correlation IDs, retention, and authorization boundaries
   so its event log does not become a second agent transcript.

Forge evidence: [`services/agent-runtime/package.json`](../../services/agent-runtime/package.json)
pins `eve@0.27.1`, while the
[agent platform audit](../plans/agent-platform-completion-audit.md) shows that
Forge already owns provider-neutral events, reconnect/resume, approvals,
idempotency, auditing, and runtime replacement boundaries. Eve's official
execution model says every turn is a durable Workflow SDK workflow, and the
published `0.27.1` package lists bundled `@workflow/*` 5.0 beta packages.
[Eve execution model](https://eve.dev/docs/concepts/execution-model-and-durability),
[Eve 0.27.1 package metadata](https://github.com/vercel/eve/blob/eve%400.27.1/packages/eve/package.json),
[Vercel's Eve announcement](https://vercel.com/blog/introducing-eve).

## What the SDK provides

| Area | Capability and implication for Forge |
| --- | --- |
| Programming model | `"use workflow"` marks a deterministic orchestrator; `"use step"` marks full-runtime, side-effecting work. The compiler splits them into separately executed handlers. This is a good fit for explicit business processes, not a reason to wrap an already-durable EVE turn. [Workflows and steps](https://workflow-sdk.dev/docs/foundations/workflows-and-steps), [code transform](https://workflow-sdk.dev/docs/how-it-works/code-transform) |
| Durability | An event log persists runs, steps, hooks, waits, inputs, and outputs. Workflow code is replayed deterministically; completed step results are reused, and suspended workflows consume no compute. Durable streams can reconnect from a prior point. [Event sourcing](https://workflow-sdk.dev/docs/how-it-works/event-sourcing), [streaming](https://workflow-sdk.dev/docs/foundations/streaming) |
| Reliability | Steps retry three times by default and support fatal errors, delayed retries, and compensation/saga patterns. External writes are not magically exactly-once: callers must use the stable step ID as an idempotency key. That matches, but does not replace, Forge's existing write-idempotency policy. [Errors and retries](https://workflow-sdk.dev/docs/foundations/errors-and-retries), [idempotency](https://workflow-sdk.dev/docs/foundations/idempotency) |
| Human in the loop | Typed hooks and HTTP webhooks can suspend a workflow until approval or other input arrives, then resume days later. They are durable waiting primitives; Forge must still enforce actor authorization, risk policy, approval UI, and audit semantics. [Human in the loop](https://workflow-sdk.dev/docs/ai/human-in-the-loop), [hooks](https://workflow-sdk.dev/docs/foundations/hooks) |
| Observability | Stable 4.x records the full lifecycle and exposes it through a CLI, local Web UI, and Vercel dashboard. The 5.x beta additionally documents end-to-end OpenTelemetry spans. Forge would need to correlate these infrastructure traces with its canonical product events rather than expose two competing histories. [Observability](https://workflow-sdk.dev/docs/observability), [5.x tracing](https://workflow-sdk.dev/v5/docs/observability/tracing) |
| Security | The Vercel World supports per-run end-to-end encryption of user payloads; lifecycle metadata remains visible. Encryption is World-dependent, so a self-hosted World needs its own key implementation and access model. [Encryption](https://workflow-sdk.dev/docs/how-it-works/encryption) |

## Runtime, deployment, and integrations

Workflow code is portable through **Worlds**, adapters that provide an event log,
queue, and compute/streaming surface:

- Local World is zero-config but uses JSON files and an in-memory queue; it is
  explicitly not production-safe.
- Vercel World is managed, serverless, encrypted, and zero-config on Vercel.
  Stable 4.x stores and routes workflow data through `iad1`; multi-region is a
  5.x beta feature. Runs remain pinned to the deployment that started them.
- The official self-hosted Postgres World uses PostgreSQL plus
  `graphile-worker` and `LISTEN`/`NOTIFY`. It requires migrations and a
  long-lived worker, so it does not fit a serverless process and adds another
  operational queue even though Forge already uses Postgres.
- Custom Worlds are possible, but compatibility is versioned. Eve 0.27.1
  specifically expects the Workflow SDK 5 beta protocol, so Forge should not
  assume a stable 4.x World can be shared with EVE.

[Deployment model](https://workflow-sdk.dev/docs/deploying),
[Local World](https://workflow-sdk.dev/worlds/local),
[Vercel World](https://workflow-sdk.dev/worlds/vercel),
[Postgres World](https://workflow-sdk.dev/worlds/postgres).

The SDK has first-party setup guides for Next.js, TanStack Start/Vite, Nitro,
Nuxt, SvelteKit, Astro, Express, Fastify, and Hono, plus AI SDK integration.
That makes a direct Forge/TanStack proof of concept technically straightforward:
the `workflow/vite` plugin must run before TanStack Start and Nitro plugins.
[Frameworks](https://workflow-sdk.dev/docs/getting-started),
[TanStack Start](https://workflow-sdk.dev/docs/getting-started/tanstack-start),
[durable AI agents](https://workflow-sdk.dev/docs/ai).

## Maturity, license, and constraints

- Vercel Workflow is generally available, and `workflow` has a stable
  `4.6.2` release. The current `5.0.0-beta.36` line remains beta even though
  EVE already vendors it. This distinction is the main maturity risk for Forge.
  [GA announcement](https://vercel.com/blog/a-new-programming-model-for-durable-execution),
  [4.6.2 release](https://github.com/vercel/workflow/releases/tag/workflow%404.6.2),
  [5.0.0-beta.36 release](https://github.com/vercel/workflow/releases/tag/workflow%405.0.0-beta.36).
- The repository and npm package use the permissive Apache-2.0 license.
  [Repository and license](https://github.com/vercel/workflow),
  [npm metadata](https://www.npmjs.com/package/workflow).
- Workflow functions are sandboxed, deterministic, and cannot use arbitrary
  Node APIs or packages; side effects belong in steps. Values crossing
  boundaries must use supported serialization and are passed by value.
- Automatic retries mean steps may execute more than once; side effects need
  domain idempotency. Build-time transforms and generated workflow endpoints
  are part of the runtime contract.
- On Vercel, the documented headroom is 50 MB per step payload and 2 GB per run,
  but storage and steps are metered. Large agent histories therefore have both
  replay and cost consequences. Workflow 5 beta adds compression and is
  developing snapshot-based replay improvements.
  [Vercel Workflow limits and roadmap](https://vercel.com/blog/a-new-programming-model-for-durable-execution),
  [Workflow pricing](https://vercel.com/docs/limits),
  [5 beta compression](https://vercel.com/changelog/workflow-sdk-now-compresses-run-and-step-payloads).

## Decision boundary

Use **EVE** when the unit of work is an agent conversation, model/tool loop,
sandboxed code execution, subagent, or agent approval. Use a **direct Workflow
SDK workflow** only when the unit of work is a deterministic Forge business
process whose lifetime and state machine are independent of any agent session.
If no such process is currently painful, Forge gains nothing by adding the
dependency now.
