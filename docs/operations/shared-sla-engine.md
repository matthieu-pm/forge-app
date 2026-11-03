# Shared SLA engine (FOR-125)

This implements [the merged SLA contract](../shared-sla-contract.md). Shared
policy is stored on the server; browser-local SLA settings have no authority.
The engine starts with no rules and a disabled policy. A workspace owner/admin
can enable it, configure ordered apply/remove rules, and resolve policy revision
conflicts at Settings → SLAs. No target is installed implicitly.

Status conditions store both team and status IDs: default IDs such as `todo`
are team-local and never treated as global state identities.

Targets measure time to completion. Elapsed days/weeks mean 24/168 hours.
Business days advance whole selected local dates in the captured team timezone,
with no office-hour or holiday calendar. Gaps shift forward; repeated local times
choose the earlier instant. Nonterminal states never pause time. The issue shows
its saved deadline in that team's captured timezone. A new due date removes the
SLA; applying an SLA clears the due date atomically.

## Persistence and recovery

Migration `0072_shared_sla_engine.sql` adds policy revisions, policy enablement
periods, immutable commitment generations, issue eligibility windows, unique
system events, and transactional dispatch intents. The issue trigger runs in the
canonical command transaction, including create/edit/triage/move/lifecycle paths.
It samples database time after locks. Import inserts do not create SLAs; a later
qualifying edit may do so. Purge cascades through commitment data. Each new table
has immutable identity and recovery-capture triggers.

The issue FK is deliberately `DEFERRABLE INITIALLY DEFERRED`: the BEFORE INSERT
trigger can write the commitment/event/intent without a second issue update,
extra revision, or duplicate automation event. Use the migration, not schema push.
Drizzle's schema snapshot does not express FK deferrability; preserve this custom
migration clause in future schema work.

The dispatcher enqueues FOR-64 jobs from committed intents, then records the job
ID. Enqueue identity includes the workspace scope and immutable generation UUID;
that generation captures the issue and deadline, and the input hash binds them.
A crash in the dispatch gap safely replays the same enqueue. The worker checks
live issue/policy/gate state under locks. Its SQL checkpoint commits the unique
breach and system history row together. Overdue transitions settle an owed breach
before invalidation; recovery never shifts a deadline or creates a second breach.
Generic job receipts retain only workspace/commitment/deadline metadata after an
issue purge; there is no issue body or policy snapshot in the job payload.

Policy/feature disablement defers jobs without spending their failure retry
budget. A completed generation can reopen using its original deadline during
the first 30 elapsed days, so an unbreached job remains recoverably deferred
through that window. A later reopen creates a new generation from the previous
duration/calendar and a fresh anchor. Different matching apply rules supersede;
explicit removal takes precedence.

## Rollout controls

Source support does not enable a workspace. All UI, reads, commands, and worker
effects require an explicit workspace entry in `FORGE_FEATURE_ROLLOUTS`, for
example `{"sla":{"mode":"enabled","workspaceIds":["<workspace-id>"]}}`.
Preview mode has no operational SLA access. Policy enablement is an additional
workspace-admin control. Preserve unrelated rollout entries when changing it.

The Vercel scheduler is packaged only when `FORGE_SLA_JOBS_ENABLED=true` at build
time. The GET `/api/internal/sla-jobs` handler also checks this flag at runtime and
requires `Authorization: Bearer <CRON_SECRET>` with a secret of at least 32
characters. Startup rejects enabled scheduling without a valid secret. The
endpoint gives no-store 404 before importing the database on denied requests.
It dispatches at most 100 intents and processes at most 20 due jobs per tick.
Vercel scheduling runs every minute; delivery can be late, and history preserves
both the original deadline/effective breach time and actual processing time.

The server records a feature identity from `VERCEL_DEPLOYMENT_ID` (or
`FORGE_SOURCE_REVISION` plus a process identity outside Vercel), workspace and
effective mode. A source revision alone cannot attest to continuity across
separate operator processes. A new
deployment cannot prove the predecessor's availability. Future unowed
commitments can adopt its identity; overdue, unclassified intervals stay
recoverable and appear in the admin interruption review. Use release/incident
evidence to record “Breach was owed” or “No breach was owed”; this classification
is receipt-backed and audited, and requires the exact observed interruption
version under the commitment lock. A stale decision cannot classify a later
interruption. It never changes the saved deadline. Already
persisted known obligations remain owed across gate changes. Review pending
interruptions after deployments and do not edit commitment rows to clear them.

Operator commands use the existing explicit-target job CLI:
`bun run jobs run-sla`, `inspect`, `reap`, and the fenced recovery commands printed
by `inspect`. `run-sla` bypasses the HTTP scheduler flag so an operator can drain
the queue manually; it still enforces each workspace's feature and policy gates.
For rollback, disable the scheduler/workspace rollout and retain the additive
tables and intents. Reenable/reconcile before resuming; do not delete the queue.

Production release still requires applying the migration with the owning
database release process, FOR-42/FOR-64 prerequisite evidence, a production
smoke test and an explicit rollout choice. This implementation PR does not apply
a production migration or change production environment settings.

## Acceptance environment

The engine tests require a dedicated PostgreSQL 17 database named
`for125_sla_test`, role `for125_test`, on `127.0.0.1:56525`. Both harnesses reject
other targets. Apply all repository migrations to that disposable database.
Set `FORGE_SLA_TEST_DATABASE_URL=postgresql://for125_test@127.0.0.1:56525/for125_sla_test`
and run `bun run test:sla:postgres` in `apps/forge`. These tests use real
PostgreSQL transactions and the application command services; the driver adapter
substitutes a local TCP pool, not mock SQL or an in-memory calculator. The crash
fixtures kill an independent process before and after the actual breach checkpoint.

For browser acceptance, build the app with a synthetic local auth configuration,
then run `bun scripts/serve-sla-acceptance.mjs` and `bun run test:sla:browser`.
The dedicated loopback WebSocket/TCP bridge exercises the unchanged built Neon
driver; the server inherits no operator service credentials. The browser harness
uses two real Better Auth sessions, distinct device timezones, policy conflicts,
admin revocation, recovery from stale conditions, uncertain-save replay and
member issue creation/reload. Run it sequentially on this
database. It creates and cleans only the fixed acceptance workspace/users, and
writes its result/screenshot under `/tmp/for125-*`.

Notification delivery remains excluded: FOR-65/FOR-145 are the conditional Inbox
prerequisites. This slice emits one durable breach/system-history event; it does
not add reassignment, reminders, an external delivery provider, a manual SLA
editor, packaged macOS qualification, or a production throughput certification.
