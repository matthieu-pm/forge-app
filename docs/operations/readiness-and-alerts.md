# Readiness and operational alerts

FOR-30 implements the operational checks using the accepted FOR-24 objective
sheet v1. These checks detect failures; they do not certify the load, recovery or
overall production launch gates.

## Health endpoints

Web: `GET /api/health/live` returns `200 ALIVE` without dependency access.
`GET /api/health/ready` checks configuration/isolation, database connectivity,
the exact required migration hash/timestamp prefix, the enabled agent runtime and
configured private Blob access. Runtime: `GET /health/live` and
`GET /health/ready` cover its process and service configuration. Runtime owns no
database pool. Web checks the runtime's readiness, not just an HTTP 200.

Readiness returns `503` with one fixed code: `CONFIGURATION_INVALID`,
`DATABASE_UNAVAILABLE`, `SCHEMA_NOT_READY`, `RUNTIME_UNAVAILABLE` or
`STORAGE_UNAVAILABLE`. Replies contain no exception, host, URL, migration hash,
credential, tenant identifier or body. Responses are not cached. Readiness has
bounded dependency deadlines; the Neon HTTP queries have an abort signal.
The Blob probe lists at most one metadata item under an operational prefix and
discards it; actual object roundtrip/durability is the storage release gate.

The build generates `migrations.generated.json` from the versioned migration
files. A parity test detects stale manifests. A newer expanded schema can still
serve old compatible code; missing, edited or reordered required receipts fail.
Configuration errors that prevent process startup still result in host failure;
an endpoint cannot run inside a process that never started.

## Enable the monitor

Apply the additive operational migration through the guarded migration runner
on the verified isolated target first. Production migration/promotion retains its
separate release gate. Keep the pooled application URL and direct migration URL
separate. The application role needs table DML and SELECT on
`drizzle.__drizzle_migrations`; it never needs schema ownership.

Configure these server-only variables through the secret manager:

| Variable                                | Meaning                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FORGE_OPERATIONS_MONITOR_ENABLED=true` | Enables authenticated execution and adds the one-minute Vercel Cron definition **at build time**. Set the same value for build and runtime.                                          |
| `CRON_SECRET`                           | At least 32 characters; Vercel sends it as a Bearer credential.                                                                                                                      |
| `FORGE_OPERATIONS_WEBHOOK_URL`          | Operator-owned HTTPS JSON webhook. No embedded credentials, query or fragment. HTTP loopback is allowed only for local development tests.                                            |
| `FORGE_OPERATIONS_WEBHOOK_TOKEN`        | 32–256 URL-safe characters sent in the Authorization header.                                                                                                                         |
| `FORGE_MONITORED_JOBS`                  | Comma-separated selection of `agent.retention,product.retention,workflow.health,calls.sync`; the default selects the first three. Only select enabled jobs with an actual scheduler. |
| `FORGE_SOURCE_REVISION`                 | Exact source SHA; alerts link to that revision's runbook.                                                                                                                            |

The webhook must accept the JSON alert envelope and return 2xx only after accepting
it. Deduplicate on the `Idempotency-Key` header. The envelope contains a fixed
code, signal, severity, numeric measurement/threshold, episode timestamp,
environment, objective version and runbook link. It contains no customer content
or webhook credentials. Redirects are refused and delivery times out after ten
seconds. Response bodies/errors are discarded. This generic webhook needs a
compatible adapter when using a provider with its own paging API format.

The protected `GET /api/internal/operations-monitor` denies unauthenticated,
disabled and wrong-method requests with empty 404 before database access.
Successful evaluation returns bounded counts. Delivery/collection failure returns
503 and does not claim successful alerting. A detected incident that was delivered
returns 200 so the scheduler can distinguish evaluation success from service health.

`operational_job_health` records **successful completion**, not scheduler invocation.
The existing retention, Calls and workflow-health scripts write this record only
when they finish successfully; partial failures preserve the previous completion
and record failure. Deployment does not create success heartbeats. Schedule the
two retention scripts every fifteen minutes in the existing job runner; monitor
execution does not run retention or retry business effects itself.

## Accepted rules and actual sensors

| Signal                                     | Warning                  | Page                              | Current source                                                                |
| ------------------------------------------ | ------------------------ | --------------------------------- | ----------------------------------------------------------------------------- |
| Completed retention sweep age              | >30 min                  | >60 min                           | Durable successful job heartbeat                                              |
| Other selected job completion age          | —                        | >1 h                              | Durable successful job heartbeat                                              |
| Job failure after its last completion      | —                        | Immediate                         | Failed heartbeat                                                              |
| Eligible initial invitation mail/event age | >30 s                    | >60 s                             | Pending/sending/failed initial workflow effect; future reminders are excluded |
| Oldest queued/starting job                 | —                        | >1 h                              | Workflow run queue                                                            |
| Stale lease                                | —                        | >5 min                            | Calls sync/summary leases                                                     |
| Global queued workflow backlog             | ≥80% of 10,000 for 5 min | —                                 | Workflow queue count and durable sampled saturation start                     |
| Database connection slots                  | —                        | No unreserved physical slots left | PostgreSQL settings/`pg_stat_activity`; this is not PgBouncer wait time       |
| Missing/future enabled sample              | —                        | Immediate                         | Explicit `SIGNAL_MISSING`                                                     |
| External sample age                        | —                        | >2 min                            | Explicit `SIGNAL_STALE`; collection gaps cannot prove sustained saturation    |

The initial workflow queue is the currently implemented durable substrate, not a
claim that future FOR-64 jobs already exist. New workers must extend collectors
and parity tests at their enablement gates. Physical database slot detection does
not prove CPU, I/O, pooler or capacity health; those require external provider
monitoring/load evidence. No new agent concurrency limit is introduced.

`evaluateMonitor` also defines the accepted outbox/inbox lag, failed-upload age
(>1 h), sustained backlog and account/issue synthetic result contracts. Their
canonical backends are separate issues. Enabling `FORGE_MONITOR_OUTBOX`,
`FORGE_MONITOR_UPLOADS`, `FORGE_MONITOR_ACCOUNT_JOURNEY` or
`FORGE_MONITOR_ISSUE_JOURNEY` without real samples produces `SIGNAL_MISSING`,
never a green result. Do not present initial email events as a complete inbox
synthetic, a healthy process as provider health, or fixtures as a working issue
product. Those surfaces must attach their actual collectors/journeys before
feature enablement. No account/issue product writes are performed by health probes.

## Delivery and recovery

Normal alerts use a durable 30-second claim and a stable episode/severity delivery
ID. Concurrent monitor invocations have one sender. A warning can escalate to a
separate page. Failed sends release the claim; crashed senders are retried after
lease expiry. A stale sender cannot acknowledge a new owner's delivery. A crash
between receiver acceptance and SQL acknowledgement can resend the same ID, so
the receiver must deduplicate; exactly-once HTTP delivery is not claimed.

If readiness/database/schema fails, paging still uses the webhook directly without
requiring the broken database. These fallback alerts use an hourly idempotency
bucket and rely on receiver deduplication. Collector failure similarly pages and
returns 503. Missing webhook configuration fails closed. No raw dependency failure
is included. Retain delivery receipts until the operator's incident retention
policy is applied; no automatic receipt purge is introduced here.

The monitor cannot report its own total scheduling/platform outage. Operations
must configure an independent external dead-man/uptime check for the monitor's
one-minute invocation and the public readiness URL, and test actual on-call
routing before launch. This is separate from successfully executing a Cron API.

On an alert:

1. Follow the source-pinned runbook and bounded signal/code. Check the named
   environment and serving revision before any recovery action.
2. For readiness/schema failure, inspect verified resource identity and the
   serialized migration journal. Do not run `db:push`, edit history, or switch
   production pointers as a repair.
3. For a stale sweep/lease/job, inspect its owner, last successful completion and
   failure code. Reconcile uncertain effects before replay. Never reset data
   expiry or spending clocks to make a heartbeat green.
4. For mail/outbox/upload lag, inspect pending effects and the owning subsystem's
   recovery procedure. Do not discard accepted work. Escalate unreconciled
   failures to Operations and Engineering.
5. For delivery failure, check webhook routing/receiver health and retry the same
   ID after receiver reconciliation. Verify recovery with a new successful
   completion/sample and the next monitor run.

## Reproducible acceptance

Run the focused tests in `apps/forge`:

```sh
bunx vitest run src/application/operations/readiness.test.ts src/application/operations/monitor.test.ts
FORGE_OPERATIONS_TEST_DATABASE_FILE=/private/staging.json bunx vitest run src/application/operations/monitor.postgres.test.ts
```

The private JSON file has `{connection}` with a direct staging operator URL. The
PostgreSQL suite verifies the actual branch/database before mutation, creates one
random owned schema, exercises the real migration SQL, readiness, stale completion,
HTTP receiver, concurrent claims and expired-owner fencing, then drops only that
schema. It never changes the public migration history or customer records.

Hosted acceptance uses `deploy:staging web|runtime --operations` with a private
random token's SHA-256, expiry within two hours and an owned `for30_<32 hex>`
schema. The web probe executes real missing-journal and disconnected-client
checks, then sends a stale-job page through the production dispatcher to the
separate runtime's synthetic operator inbox. The receiver validates/project-scopes
authority and logs only the bounded test alert. A retry is suppressed by the
SQL receipt. Anonymous, expired and non-staging probes return empty 404. No model
execution, customer mutation or real-person notification occurs.

Keep the exact source, immutable deployment IDs, challenge, safe responses,
retained receiver log, database receipt and cleanup record as acceptance evidence.
Hosted acceptance proves the enabler in isolated staging. Production alert routing,
scheduler configuration and independent watchdog remain deployment prerequisites.

## Accepted staging evidence · 29 October 2026

At source `2b06271e6f0eed118105a62468522c21d9e06f94`, both hosted acceptance
criteria passed. The [evidence record](for30-readiness-alerts-evidence.json) contains
the exact web/runtime deployments, healthy endpoints, safe 503 fault responses,
stale-sweep page, retained separate receiver log, SQL receipt and suppressed retry.
The owned probe schema was removed; local raw operator/database credentials were
deleted. Staging retains the additive operational tables (40 migrations), with
zero users, organizations and sessions after cleanup. No production rollout or
real-person paging is claimed.

The connectivity fixture deliberately closes a connected SQL client. With
`neonConfig.poolQueryViaFetch=true`, `Pool.query()` can bypass pool lifecycle via
HTTP even after `Pool.end()`; closing only a pool does not inject a disconnect.
The opt-in PostgreSQL regression runs with that web setting enabled.

Validation: 1,878 app tests, 4 Workflow tests, 25 runtime tests and 6 separately
opted-in PostgreSQL tests passed; TypeScript and production builds passed.
Changed-app lint has zero errors (fixture async/cleanup warnings remain). One
unrelated review-panel timing assertion failed during a parallel suite run, then
passed in its focused rerun and the subsequent full app/Workflow run.
