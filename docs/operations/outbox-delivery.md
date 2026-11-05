# Recoverable outbox delivery (FOR-33)

`runOutbox(pool, consumers, limit)` admits committed FOR-32 events and drains at
most 100 deliveries per call through the FOR-64 runner. It is the integration
boundary for provider adapters. This change registers no live provider, changes
no existing email/webhook path and adds no scheduler. Product integrations call
this boundary from their authenticated worker and qualify their provider contract
before enablement. The loopback adapter in `scripts/fixtures` is only for tests.

## Enable a consumer

Supply a versioned consumer ID, exact topic and payload version, stable provider
account/destination reference, inclusive `startsAt`, payload parser, authoritative
lookup and delivery adapter. Choose the cutover deliberately: historical events
at or after it are eligible for backfill. Unregistered topics remain untouched.
The parser must validate the payload and project only authorized fields. Adapters
own live resource, recipient and integration authorization; committed intent is
not perpetual access.

The envelope has version 1, event ID, workspace, command ID, ordinal, topic,
explicit payload version, creation time and parsed payload. Legacy topics need
an explicit version mapping; the worker never guesses from a topic suffix.
Bump the consumer ID and define a new cutover when changing effect semantics or
destination. Changing provider identity or payload version under an existing job
fails closed. Credential rotation for the same account preserves business identity.

Scheduling binds `(outbox-delivery-v1:<consumer>, outbox, <consumer>:<event UUID>)`
to immutable reference-only job input. Concurrent enqueue deduplicates through
FOR-64. The retained job is the delivery tombstone; partial scheduling resumes
without a cursor that could skip events. Do not purge jobs or mint new identities
to retry effects. Jobs for absent consumers are not claimed. Consumers process
the same event independently; no cross-event ordering is promised. Failures return
per-item outcomes and do not stop unrelated work. Callers must inspect outcomes
before reporting successful execution.

## Provider safety

First dispatch and automatic retries begin with reconciliation using the same
event/consumer/provider identity and persisted job-step key. `accepted` returns
the authoritative opaque provider reference; `absent` must be an authoritative
negative result; uncertainty returns `unknown` or throws. Unknown or malformed
results stop for reconciliation. A missing local receipt is not provider absence.

For verified provider idempotency, configure its guaranteed window in milliseconds.
FOR-64 persists the first deadline and never extends it on automatic retries.
Adapters must use the supplied key and deadline on every request/internal retry,
honor the shared 30-second abort signal and stop before the deadline. The worker
reserves 35 seconds before dispatch. The guarantee must cover concurrent requests
and late arrivals. Otherwise select `reconcile`: a started effect never dispatches
automatically again, including after lease expiry. Lookup is read-only and no
network call runs inside a transaction.

The confirmed opaque reference is checkpointed as `provider-reference-v1`; response
bodies are discarded. A crash after acceptance but before checkpointing uses lookup
on resume. A crash after checkpoint completion skips the effect. Expired windows
stop for operator reconciliation. SQL fencing cannot cancel remote requests.

## Inspect and recover

Use the explicit-target [job operator CLI](background-jobs.md):

```sh
bun run jobs list
bun run jobs inspect <job-uuid>
bun run jobs reap
```

The kind identifies the consumer. Inspection shows attempts, failure code, step
states and a same-job recovery command. An operator with database credentials for
the intended environment can locate delivery/provider references:

```sql
SELECT j.id, j.kind, j.state, j.generation,
       j.input->>'eventId' AS event_id,
       j.input->>'consumerId' AS consumer_id,
       j.input->>'providerId' AS provider_id,
       s.result->>'reference' AS provider_reference
FROM background_jobs j
LEFT JOIN background_job_steps s
  ON s.job_id=j.id AND s.key='provider-reference-v1'
WHERE j.kind LIKE 'outbox-delivery-v1:%'
  AND j.state IN ('dead','reconcile')
ORDER BY j.updated_at,j.id
LIMIT 100;
```

Five failed claims exhaust the default budget, including crash claims. Establish
former-worker/request quiescence and verify the exact provider identity. Follow
FOR-64's audited, generation-checked `resolve` and separate `replay` on the same
job. An unresolved started effect cannot be replayed, even in a dead letter.
Resolve `completed` only with acceptance proof, or `retry-safe` only with proof
of absence and quiescence. Provider-confirmed completion needs no invented response.
Preserve jobs, steps and recovery receipts on rollback.

## Alerts and rollout

Enable `FORGE_MONITOR_OUTBOX=true` with the configured FOR-30 monitor and webhook.
It collects age of admitted unfinished deliveries and pages immediately with
`OUTBOX_DEAD` or `OUTBOX_RECONCILIATION_REQUIRED`. Alerts contain aggregate counts
and stable episode identity, never payloads, workspace IDs, credentials or provider
responses. Aggregation covers all failures without starving later dead letters
behind a bounded first page. Existing durable alert claims retry failed sends
and suppress acknowledged episodes. Use the inspection query to locate jobs.

This collector covers admitted jobs, not unregistered topics or consumers whose
scheduler never ran. Qualify scheduling, lag from commit to admission, independent
scheduler watchdog and real on-call routing at each integration's release gate.
The monitor never retries business effects. No new migration is required; deployed
FOR-32/FOR-64 tables and FOR-30 alert receipts are reused. Production deployment,
live provider contracts and hosted acceptance remain separate release gates.

## Local acceptance

The opt-in suite requires dedicated PostgreSQL 17 on
`127.0.0.1:56433/for33_outbox_test`. It rejects other targets, applies all migrations
to a fresh database and removes its workspace/job/alert fixtures. No cloud credentials
or customer data are needed.

```sh
cd apps/forge
FORGE_OUTBOX_TEST_DATABASE_URL=postgresql://<local-role>@127.0.0.1:56433/for33_outbox_test \
  bunx vitest run src/application/jobs/outbox.postgres.test.ts --testTimeout 30000
```

AT-01 kills an independent Bun worker after a separate HTTP provider accepts the
effect. After lease expiry, lookup recovers its reference with only one POST.
AT-02 exhausts five attempts, inspects the dead letter, retries a failed HTTP alert,
verifies suppression, completes unrelated work and exercises same-job recovery.
Further cases cover bounded/concurrent scheduling, uncommitted/unregistered events,
consumer isolation, version/provider identity, malformed lookup/payloads, expired
deduplication and operator-only reconciliation. HTTP fixtures check for open worker
transactions during provider requests.
