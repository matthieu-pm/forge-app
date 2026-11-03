# Durable background jobs (FOR-64)

The shared PostgreSQL runner owns job identity, due time, leases, fencing, checkpoints, retry budgets and operator recovery. A scheduler invocation is only a trigger. `background_jobs.state='completed'` is execution evidence; an invocation or lease acquisition is not success.

## First consumer and integration boundary

Product retention now enqueues `workflow-retention-v1` once per UTC day and drains due occurrences. It deletes only terminal business Workflow records older than the stored 90-day cutoff. Each batch selects at most 500 rows in UUID order with row locks, deletes them and commits its count checkpoint on the same connection. Active and recent records remain. SDK effect rows retain their existing cascading deletion behavior. Other product retention stages retain their existing implementation.

Daily scheduling deliberately freezes the cutoff at midnight UTC, so a record can remain up to one additional day compared with the previous invocation-relative cutoff. Duplicate same-day triggers share the original identity and input. Failed/dead occurrences retain their checkpoints. Product retention cannot report success while today's durable cleanup is incomplete, including overlap with a live owner.

The substrate has no public HTTP API. The existing scheduler/CI invokes product retention. The operator CLI also schedules and drains the maintenance consumer. This issue does not migrate invitation workflows, Loop execution, file deletion, email delivery or command outbox delivery. FOR-33 and other consumers should use these boundaries rather than creating lease engines. Workflow SDK continues to orchestrate its existing durable invitation lifecycle. A future SDK step can call the same runner using a stable business job identity; SDK execution IDs must never become job/effect identity, and ambiguous SDK starts cannot authorize a second effect.

## Worker contract

- `enqueue` binds `(kind, scope, identity)` to canonical input hash, due time and retry budget. Use versioned kinds and immutable reference-only inputs; keep bodies, credentials and transcripts out. Changed input under an existing identity conflicts. Use a new version for changed checkpoint semantics.
- `claim` atomically locks one due job with `SKIP LOCKED`. Every claim increments generation, attempt and lifetime attempt count and generates a fresh UUID token. Default lease is five minutes. A handler must renew between bounded steps, and external calls must fit the lease or arrange renewal. Renewal fails after expiry; it cannot resurrect ownership.
- `sqlStep` locks the job, checks token/generation/expiry, executes a **SQL-only callback on the supplied connection**, writes its bounded JSON result checkpoint, then checks expiry again before commit. Never use the global DB client or make external calls in this callback. Cached results skip the callback on replay. This API does not replace actor/resource authorization in domain commands. Such handlers must authorize in the same transaction using the relevant domain boundary; effects, receipts and outbox intents must share it.
- `externalStep` records started intent before invoking one external effect. It intentionally returns `void`, so provider-confirmed operator completion can resume without invented provider output. Store only minimal identity references in the job; reconcile using the provider's business/effect identity.
- `provider-idempotent` steps require a provider-guaranteed deduplication deadline (`validUntil`) and use the same SHA-256-derived key for this job/step on every attempt. The first deadline is persisted and cannot be extended by automatic retries. The callback receives the persisted deadline as its second argument. The adapter must enforce it on every request and internal retry, with sufficient margin for request transit and provider processing, and stop dispatching before it expires. A provider key must cover the exact effect and remain valid for the entire request. Expired windows stop for reconciliation. Do not select this mode for an unverified provider contract.
- `reconcile` steps never automatically repeat a started external request. Any uncertain failure or expired lease stops in `reconcile`. SQL fencing cannot cancel an already-dispatched provider request.
- Handler completion rejects unfinished steps. Do not fire-and-forget work from handlers. The SQL runner uses 30-second statement/idle-transaction limits and a five-second lock timeout. Keep individual SQL batches short. Stored JSON is limited to 16 KiB per input/result.

Retries use persisted database time and exponential delays: 30s, 60s, 120s, 240s, up to one hour. Five claims are allowed by default, including crash claims; enqueue can choose 1–20. Permanent typed errors dead-letter immediately. Exhausted expired claims dead-letter too, unless external ambiguity requires reconciliation. A dead-letter is a retained job, not a deleted record. No automatic job/checkpoint/receipt purge is included because deleting identity tombstones permits duplicate effects.

## Operator CLI

Select the intended database explicitly. `DATABASE_URL` and `FORGE_ENVIRONMENT` must already be set. The CLI preserves this target rather than using local dotenv overrides. Use the serving environment's ordinary SQL connection and appropriate operator credentials; do not paste credentials into tickets, logs or shell history. Access to this CLI is controlled by database credentials, not a workspace member role. Recovery audit records include the supplied operator UUID and the database `session_user`.

From the repository root:

```sh
bun run jobs list
bun run jobs inspect <job-uuid>
bun run jobs reap
bun run jobs schedule-retention
bun run jobs run
bun run jobs run <job-uuid>
```

`run` only executes the registered Workflow-retention handler. `reap` examines at most 100 expired owners per invocation. Repeat if needed. Failed worker outcomes return nonzero exit status; idle and completed runs return zero. Inspection returns state, schedule, attempt/generation, lease deadline, bounded failure code and the latest 100 step summaries (started external steps first). It excludes job input, checkpoint results, lease tokens, provider keys and raw exceptions. List is limited to the newest 100 jobs; inspect a known UUID for older work.

For `dead`, fix the dependency or handler first. Then replay **the same job**, preserving checkpoints and effect keys:

```sh
bun run jobs replay <job-uuid> --generation <observed-generation> --request <request-uuid> --operator <operator-uuid> --reason code-fixed
```

Allowed replay reasons: `code-fixed`, `dependency-restored`, `provider-confirmed`. Replay resets the current retry budget and increments generation; lifetime attempts remain. A stale generation or live/completed job rejects replay. Retry the exact request UUID/arguments after a lost response. A changed request conflicts, and a new request based on the old generation cannot replay twice.

For `reconcile`, **stop and verify the former worker process and all outstanding provider requests are quiescent**. A lease timeout does not prove this. Inspect the provider's authoritative record using the stable effect identity. Record the verification in an incident/issue reference (for example `FOR-64`). Do not assert quiescence based only on elapsed time or absence of a local receipt.

If the effect already completed, acknowledge the checkpoint. If authoritative evidence proves it did not complete and cannot still arrive, mark it safe to retry:

```sh
bun run jobs resolve <job-uuid> --generation <observed-generation> --request <request-uuid> --operator <operator-uuid> --reason provider-confirmed --step <step-key> --outcome completed --quiesced true --evidence <incident-reference>
bun run jobs resolve <job-uuid> --generation <observed-generation> --request <different-request-uuid> --operator <operator-uuid> --reason provider-confirmed --step <step-key> --outcome retry-safe --quiesced true --evidence <incident-reference>
```

Choose one outcome per step. Evidence references accept letters, digits, colon, dot, underscore and hyphen, maximum 200 characters. Resolution is audited, increments generation and leaves the job stopped. Inspect again, resolve any remaining started steps, then issue a separate replay with the current generation. An idempotent step explicitly resolved retry-safe can acquire a newly verified provider window on its next attempt. If safety cannot be established, leave it in reconciliation. Do not delete a lease, checkpoint or receipt to force retry.

`JOB_FAILED` means investigate the registered handler/dependency without logging its exception. `LEASE_EXPIRED` means the previous process did not complete within ownership; reaping chooses retry, dead-letter or reconciliation. `LEASE_LOST` means this process must stop writing. `RECONCILIATION_REQUIRED` means an external effect needs the procedure above. `IDENTITY_CONFLICT` and `RECOVERY_CONFLICT` require checking immutable input or refreshing operator state, not inventing a new job key.

## Telemetry and rollout

`jobs.run` emits the existing allowlisted structured events with job UUID and attempt, never inputs, checkpoint bodies, provider output or raw error messages. Inspection provides durable queue/lease timestamps for freshness analysis. Final scheduler freshness thresholds and alert delivery remain FOR-30 release evidence.

Apply additive migration `0070_durable_background_jobs.sql` using the repository's guarded serialized migration runner before serving this consumer. Regenerated readiness hashes include it. Grant the serving/maintenance role SELECT/INSERT/UPDATE on all three new tables if default grants do not cover them. Recovery is intended for operator credentials; web APIs never expose it. Retain these tables and checkpoints on application rollback. Production migration and deployment need their separate source/target release gates; local acceptance is not a production rollout.

## Deterministic acceptance

The integration suite requires a dedicated local PostgreSQL server on `127.0.0.1:56464` and database `for64_jobs_test`. It refuses any other host/port/name, checks the server database identity, applies the complete migration chain if absent, and removes only its UUID-scoped fixtures. It uses native `pg` only as a development dependency; production keeps the existing Neon driver. No cloud database credentials or customer data are needed.

```sh
cd apps/forge
FORGE_JOB_TEST_DATABASE_URL=postgresql://<local-role>@127.0.0.1:56464/for64_jobs_test bunx vitest run src/application/jobs/jobs.postgres.test.ts --testTimeout 30000
```

AT-01 kills an independent Bun worker with SIGKILL before SQL commit and after committed checkpoint, expires the lease using a fixture transition, then resumes another worker and verifies one committed effect. AT-02 exhausts retries, inspects safe state, tests idempotent operator recovery with generation checks and proves retained checkpoints prevent a second mutation. Additional cases cover concurrent claims/enqueue, future scheduling, old-owner rejection, provider keys and ambiguity, and real bounded Workflow-retention deletion against the fully migrated schema.
