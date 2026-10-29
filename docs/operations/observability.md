# Correlation and payload-safe diagnostics

FOR-29 adds version 1 structured JSON events on stdout (`console.info`). The
web app, maintenance jobs and runtime callbacks use `packages/telemetry/server.ts`.
No remote collector, new secret, schema migration or product-feature enablement is required.
Attach the platform's log drain to these JSON records using the operator's existing
access and retention policy. Do not configure body, header or model-prompt capture
in that drain.

## Following a failure

1. Read `x-correlation-id` and `x-request-id` from the HTTP response. Forge always
   generates a new UUID request ID. A UUID `x-correlation-id` (or legacy UUID
   `x-request-id`) can continue a caller's correlation; other values are discarded.
   These headers are diagnostic labels and never grant access.
2. Filter `correlationId` across app/runtime records. Request records identify the
   transport category and status; command records add a generated `commandId`.
   Nested domain commands retain the enclosing capability command ID. No user,
   credential, idempotency-key, team-name or capability-input values are logged.
3. `forge.run.linked` connects the request to an agent `runId` or workflow
   `businessRunId`. A signed runtime channel claim carries the correlation ID
   into server-side auth attributes; tools/model callbacks forward it back to
   Forge. An older channel token without this optional claim uses its run ID.
   Reconnects and approval resumes are linked by the stable run ID even when a
   new request initiates them. Do not log the runtime session cursor: it contains
   continuation authority.
4. Durable invitation steps use the business run ID as their local correlation ID.
   Search that same `businessRunId` to reach the original request's start/link
   event. The existing one-ID workflow input remains unchanged, so delayed steps
   and replay do not depend on a process-local request context. The business row
   provides the Workflow SDK run mapping; the SDK ID is not copied to general logs.
5. For maintenance scripts, filter `jobId` for one invocation. A top-level runtime failure
   emits `forge.operation.failed` and exits nonzero without printing the exception.
   A partial failure emits `forge.job.health` with a nonzero `failures` count and
   exits nonzero. Configuration validation still precedes data/network effects.

The optional `deploymentId` is the current process's `VERCEL_DEPLOYMENT_ID`
(`dpl_…` only). `sourceRevision` accepts a full hexadecimal Git SHA from
`FORGE_SOURCE_REVISION` or `VERCEL_GIT_COMMIT_SHA`. Other environment values are
not serialized. Missing identity is omitted rather than guessed.

## Events and measurements

| Event/operation | Measurements and interpretation |
| --- | --- |
| `forge.request.completed` / `forge.request.failed` | HTTP status and `durationMs` through response creation. A 5xx is failed; 4xx remains a completed transport request. Read the status to classify authorized denials versus unexpected failures. For SSE/proxy responses this is header-ready time, not model time or final-byte latency. |
| `forge.operation.started/completed/failed/rejected` | Command, capability, callback, mail, job and workflow-start lifecycle. Duration uses a monotonic clock. Returned `{ok:false}` is rejected, with a bounded error code; thrown errors are failed. A completed job can contain partial failures: inspect its health record and exit status. |
| `forge.run.linked` | Request ↔ run/business-run mapping, including runtime authentication and model callbacks. |
| `forge.run.usage` / `agent.run` | Per-event input/output/cache tokens and cost in integer micro currency units from normalized usage. These are usage observations, not billing settlement; replayed provider events must be deduplicated using the canonical run/event store for financial reporting. No model ID or prompt is logged. |
| `forge.run.failed` / `forge.run.finished` | Fixed failure code and elapsed run duration. Finished means stream consumption ended (including waiting, cancellation or failure); it does not assert successful execution. The authorized canonical run row carries the actual state. |
| `forge.operation.started` / `agent.run` | `queueAgeMs` between run creation and start. |
| `forge.job.health` / `workflow.health` | Count of missing starts, bounded failure count and business-run queue-age samples. Failure records retain business-run identity. |
| `forge.lease.acquired/skipped/released` / `calls.sync` or `calls.summary` | Existing lease claim outcome; skipped includes busy/ineligible/missing records. Calls sync reports observed `leaseAgeMs` and summary backlog count. Reclaim thresholds remain 15 minutes for sync and 10 minutes for summaries. A claim is not proof of live worker health. |
| `forge.job.health` / retention or sync | Aggregate deletion/import/backlog/failure counts, never row contents, object keys or provider response bodies. |

Measurements are finite, nonnegative numbers. UUID fields, event names, operation
names, error codes, deployment IDs and source revisions are independently
validated at the sink. Unknown fields are dropped. Error messages, stacks, causes,
provider error names, signed URLs, headers, bodies and arbitrary dimensions cannot
be submitted as telemetry. The sink ignores its own failures so instrumentation
cannot change a business result. Future fields/labels must be added to the central
allowlist and covered by a sensitive-fixture test.

## Failure-content boundary

Capability execution and runtime failure events use fixed messages/codes. Failed
provider tool outputs are not emitted as successful tool content. SSE transport
errors omit the underlying exception. Unexpected server-function exceptions are
replaced before TanStack's logger/serializer; redirects, not-found control flow and
explicit `Response` results keep their existing behavior. Expected business
rejections should continue to use typed result values for actionable UI copy.

Private authorized conversation content and successful tool results remain in the
existing product event store/stream. That store is not the diagnostic sink and must
not be forwarded wholesale to an error collector. Tokens and credentials remain
restricted to their existing authenticated transport/secret-storage paths.

## Pinned runtime dependency boundary

EVE 0.31.0 originally included complete provider errors/cause chains in its
structured logger, subscribers and OTel exceptions. The three reviewed replacements
in `services/agent-runtime/vendor/eve/` project the real framework logger to UUIDs,
a few numeric fields and fixed messages, and remove raw errors from the two
workflow-attribute warning paths.

`apply-diagnostic-policy.mjs` runs at root postinstall when EVE is installed and before runtime
build/dev/start/eval/test. It checks the exact dependency version, original file
SHA-256 and replacement SHA-256, then replaces files atomically. Already-applied
sources are accepted; unknown versions/content fail the build/start. Atomic rename
avoids changing shared package-cache inodes. This explicit installer is necessary
because Bun 1.3.5's patch packaging dropped EVE's shipped nested dependencies during
verification. No package upgrade or vendored third-party dependency tree is included.

Keep this policy until EVE offers an equivalent safe contract; any upgrade must
review these replacements and run `runtime-logging.test.ts` against the installed
implementation, not a mock. Detailed framework messages are
intentionally unavailable to the operator; follow the run ID and bounded failure
code instead.

`agent/instrumentation.ts` explicitly sets `recordInputs=false`,
`recordOutputs=false` and `traceChannelRequests=false`, and projects only validated
run/correlation UUIDs into model span context. It does not register a remote span
exporter. Platform/collector auto-instrumentation must follow the same policy.
Framework development console output and external log-drain configuration are not
certified by these tests; production builds and authored error paths are the gate.

## Validation and scope

Run `bun run typecheck` in app and runtime, the observability/gateway/coordinator/
HTTP/normalizer tests in `apps/forge`, and `bun run test` in the runtime. Leak fixtures
include a bearer token, private transcript, signed URL, malicious error name/code,
nested cause and unsafe request ID. Tests cover concurrent request isolation,
deferred consumption after request scope exit, approved-write failures, signed
runtime correlation, callback failures and framework exception sanitization.

The browser-local issue product does not need to be migrated to test this
technical enabler. A staging-only synthetic issue-write command dispatches a bounded
UUID envelope to a separate runtime worker, which fails the injected write with
fixture secrets inside its exception. Both services emit their production telemetry
through the same correlation/command/run IDs. This verifies the failure/capture
boundary without writing a customer issue or executing a model. Canonical issue
commands must use the same observer when their separate backend work lands.

For hosted acceptance, generate a random 32-byte base64url operator token locally.
Pass only its SHA-256 and an expiry within two hours as
`FORGE_OBSERVABILITY_CHECK_TOKEN_SHA256` / `FORGE_OBSERVABILITY_CHECK_EXPIRES_AT`
to `bun run deploy:staging runtime --observability` and
`bun run deploy:staging web --observability`. Both commands deploy clean source
snapshots to the existing isolated staging projects. Do not persist the probe
settings on the projects. Confirm both serving aliases point to that source.

Run `FORGE_OBSERVABILITY_CHECK_TOKEN=<ephemeral token> bun run observability:check`
from that exact source; inject the token through the operator's environment, never
shell history or command arguments. The verifier sends authorization over curl stdin
and prints only bounded acceptance evidence. It verifies anonymous denial and checks
the two deployment identities, challenge, source revision and full correlation
chain. Then query both deployments' logs by the returned correlation UUID and verify
the failed-command/failed-worker records contain no fixture content. Delete the local
raw token after verification. The deployment-local hashes expire automatically.
Both probe routes return empty 404 outside staging, without valid probe authority,
or after expiry. The probe imports no database, model or business-write services.

This is the diagnostic foundation. Database pool saturation, durable outbox/import
metrics, alert routing/readiness and lease recovery for future jobs belong to the
owning features (including FOR-30/FOR-64). Missing samples must not be treated as
zero backlog or a healthy scheduler. These events alone do not prove FOR-24's
final-byte latency, availability or notification-delivery objectives.
