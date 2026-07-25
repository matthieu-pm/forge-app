# Flags SDK evaluation for Forge

Research date: 2026-07-25. Sources are limited to Forge's repository and
first-party Flags SDK, Vercel, GitHub, and npm material.

## Verdict

**Useful design, wrong direct dependency for Forge today.** Flags SDK provides a
good typed, server-first facade over environment variables or a remote flag
provider, plus request-scoped targeting, per-session developer overrides,
provider adapters, and evaluation telemetry. Those capabilities would matter
when Forge needs to change a rollout without redeploying or target it by
workspace/user.

Forge does not need those capabilities for its current flags yet, and the
official SDK does not support Forge's framework. The current `flags@4.2.3`
package provides complete `flag()` implementations only for **Next.js and
SvelteKit**. Its generic export contains crypto, discovery, metadata, and
reporting utilities; `flags/react` only renders flag metadata/value script tags.
There is no TanStack Start/Nitro/Vite flag evaluator or request integration.
Vercel itself recommends OpenFeature or `@vercel/flags-core` for frameworks
outside Next.js and SvelteKit.
[Vercel SDK comparison](https://vercel.com/docs/flags/vercel-flags/sdks),
[`flags` package exports](https://github.com/vercel/flags/blob/flags%404.2.3/packages/flags/package.json),
[`flags/react` source](https://github.com/vercel/flags/blob/flags%404.2.3/packages/flags/src/react/index.tsx).

**Recommendation: do not install Flags SDK now.** Keep the environment-backed
implementation and introduce a small Forge-owned, server-only decision
interface when a concrete per-workspace/user rollout appears. Retain the
environment implementation as its initial backend and emergency fallback. If a
managed provider is later required, use OpenFeature for portability or
`@vercel/flags-core` specifically for Vercel Flags rather than importing the
unsupported `flags/next` runtime.

## What it would and would not replace

Forge currently has a typed catalog of 20 agent booleans, defaults, environment
variable mappings, and provider helpers in
[`agent-feature-flags.ts`](../../src/application/agents/agent-feature-flags.ts).
`agent-http-production.server.ts` resolves them once when the server module
loads, filters models/runtimes with them, enforces sensitive routes server-side,
and passes the same values through `/api/agent/features` for presentation.
Consequently the flags are deployment-wide and normally need a process
restart/redeploy to change.
[`agent-http-production.server.ts`](../../src/application/agents/agent-http-production.server.ts),
[`agent-http-handler.server.ts`](../../src/application/agents/agent-http-handler.server.ts),
[`http-agent-client.ts`](../../src/lib/agent-client/http-agent-client.ts).

Flags SDK could eventually replace:

- environment parsing and ad hoc flag declaration with typed flag functions;
- deployment-wide decisions with request-scoped user/workspace/environment
  targeting;
- redeploy-only changes with a provider dashboard, segments, percentages, and
  instant rollback; and
- custom evaluation telemetry and developer override plumbing.

It should **not** replace Forge authorization, entitlements, approval policy,
write-tool gates, or operational kill switches. A returned client flag is only
a rendering hint; every protected API and capability must continue to enforce
the decision on the server. Forge's existing plan already states this boundary.
[`agent platform plan`](../plans/agent-platform-implementation-plan.md#18-feature-flags).

The macOS application does not need its own flag client. It renders the same
hosted TanStack application as the web product, so server-resolved values
already reach both clients in one deployment.
[`desktop/README.md`](../../desktop/README.md).

## Capabilities and architecture

| Area | What the SDK offers | Forge implication |
| --- | --- | --- |
| Flags as code | Each flag is a typed function with a stable key, default, metadata, `identify`, and `decide`; call sites do not pass string keys or rebuild context. An adapter can replace decision/origin logic without changing call sites. [Flags as Code](https://flags-sdk.dev/docs/principles/flags-as-code) | This is a strong model for a future Forge decision service and flag cleanup. Forge's current typed record already captures part of the benefit. |
| Server-first evaluation | The SDK intentionally evaluates on the server and passes only resolved values to clients, avoiding client initialization, layout shifts, bundle duplication, and premature disclosure of flag names. It has no built-in client evaluator. [Server vs client](https://flags-sdk.dev/docs/principles/server-side-vs-client-side), [data locality](https://flags-sdk.dev/docs/principles/data-locality) | Matches Forge's current enforcement model. TanStack loaders/server functions would need Forge-owned integration because `flags/next` is framework-specific. |
| Targeting | `identify` establishes typed entities from request headers/cookies; decisions can target users, teams, or other entities. Request-local deduplication avoids repeating identity work. [Evaluation context](https://flags-sdk.dev/docs/principles/evaluation-context) | This is the main missing capability once Forge needs staff, workspace, plan, cohort, or percentage rollouts. Resolve identity from Forge's authenticated actor, never from unsigned client assertions. |
| Performance | Adapters may bulk-evaluate related flags, and default values handle provider failures. Next.js/SvelteKit precompute can generate static variants and route between them. [Custom adapters and bulk evaluation](https://flags-sdk.dev/docs/providers/custom-adapters), [precompute](https://flags-sdk.dev/docs/principles/precompute) | Bulk evaluation and explicit defaults are relevant. The supplied precompute and request cache implementations are not portable to TanStack Start and offer little to Forge's authenticated SPA. |
| Provider abstraction | First-party adapters currently cover Vercel Flags, Statsig, Hypertune, LaunchDarkly, GrowthBook, PostHog, Reflag, Flagsmith, and OpenFeature; custom adapters implement `decide` and optional bulk evaluation. Adapter capabilities differ—some add Edge Config, Explorer metadata, or Marketplace integration. [Provider matrix](https://flags-sdk.dev/docs/providers), [OpenFeature adapter](https://flags-sdk.dev/docs/providers/openfeature) | Provider portability is useful, but Forge should own its application-facing interface. Several adapters remain `0.x`, and OpenFeature provider/runtime compatibility still depends on the selected provider. |

## Overrides, security, and observability

Flags Explorer uses the authenticated Vercel Toolbar and an encrypted
`vercel-flag-overrides` cookie. A 32-byte, per-environment `FLAGS_SECRET`
protects overrides and can encrypt definitions/values emitted into the page.
The discovery endpoint must verify its authorization token; Vercel's Next.js
helper does this automatically, but Forge would need to implement and test the
generic endpoint itself.
[Flags Explorer reference](https://vercel.com/docs/flags/flags-explorer/reference),
[`verifyAccess` and encryption APIs](https://flags-sdk.dev/docs/api-reference/core/core).

These controls prevent arbitrary cookie tampering and accidental flag
disclosure; they do not turn a feature flag into authorization. In particular,
an intentionally granted developer override can change a flag result. Forge
must never allow an override to grant a permission, entitlement, write
capability, or bypass a kill switch. Overrides should initially be limited to a
read-only visual rollout and disabled in the desktop renderer until its toolbar,
cookie, CSP, and session behavior have been verified.

Flag evaluations report automatically to Vercel Runtime Logs and can annotate
Web Analytics when running in Vercel's request context. Version 4.2.3 also
accepts an OpenTelemetry tracer provider and emits flag/evaluate/batch spans;
outside Vercel, Forge would need to wire that provider and its own product
analytics.
[Vercel observability](https://vercel.com/docs/flags/observability),
[`reportValue` implementation](https://github.com/vercel/flags/blob/flags%404.2.3/packages/flags/src/lib/report-value.ts),
[`setTracerProvider` implementation](https://github.com/vercel/flags/blob/flags%404.2.3/packages/flags/src/lib/tracing.ts).

## Maturity, license, and cost

- `flags@4.2.3` is a stable major version, published on 2026-07-24, with active
  recent work on bulk evaluation, tracing, and compatibility. The repository is
  MIT licensed. Provider adapter packages are less uniform and range from
  `0.x` to `1.x`.
  [`4.2.3` metadata and changelog](https://github.com/vercel/flags/tree/flags%404.2.3/packages/flags),
  [MIT license](https://github.com/vercel/flags/blob/flags%404.2.3/LICENSE.md).
- The SDK is free, open source, and can use a local `decide` function, so it
  does not itself require hosted flag infrastructure or Vercel. A remote
  provider adds that provider's latency, availability, data-handling, and cost.
- Vercel Flags, the separate managed provider, became generally available in
  April 2026. It costs $30 per one million configuration reads; Hobby is capped
  at 10,000 reads per month, while Pro/Enterprise allow paid overage. A request
  evaluating multiple flags from one source counts once. Limits include 100
  flags/segments on Hobby and Pro Trial and 10,000 on Pro/Enterprise.
  [Vercel Flags GA status](https://vercel.com/blog/vercel-flags-platform-native-feature-flags),
  [Vercel Flags pricing and limits](https://vercel.com/docs/flags/vercel-flags/limits-and-pricing).
- Flags Explorer is GA and includes 150 override applications per month on all
  plans. Unlimited overrides cost $250/month on Pro and Enterprise and are not
  offered on Hobby.
  [Flags Explorer pricing](https://vercel.com/docs/flags/flags-explorer/limits-and-pricing).

## Low-risk adoption boundary

Wait until Forge has a real requirement such as “enable Agent Skills for staff
and selected workspaces, then ramp from 5% to 100% without redeploying.” At that
point:

1. Add a server-only `FeatureDecisionService` with a typed catalog and an
   explicit context containing deployment, authenticated user, and workspace.
   Keep the present environment resolver as the first implementation and
   default/fallback source.
2. Evaluate once per request and expose only the minimum resolved UI values.
   Re-evaluate on every protected server path. Keep permissions, entitlements,
   policy, and kill switches outside the rollout provider.
3. Spike one reversible, read-only flag such as `agent_skills`; do not begin
   with `agent_write_tools`, provider credentials, billing, or authentication.
   Test provider outage/default behavior, latency, stable bucketing, audit
   correlation, and web/macOS consistency.
4. For a remote backend, prefer OpenFeature with the provider of choice. If
   Forge deliberately chooses Vercel Flags, use its framework-independent core
   or OpenFeature provider. Revisit Flags SDK itself only after an official
   TanStack Start/Nitro integration exists.

Until then, adopting `flags` would mostly add custom integration work around an
unsupported framework while preserving the same environment-backed decisions.
The concepts are worth borrowing now; the package is not.
