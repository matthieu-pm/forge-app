# Database migration ownership and rehearsal

FOR-27/FOR-28 implementation evidence, updated 29 October 2026. Production execution stays
disabled until FOR-25 verifies the actual serving database and source revision.

## Provisioned targets

| Use | Neon branch | Direct host | Database | Lifecycle |
| --- | --- | --- | --- | --- |
| Persistent staging | `br-autumn-union-za0opf1e`, renamed `staging` | `ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech` | `forge_staging` | No expiry |
| Disposable rehearsal | `br-little-pond-zabdmew3` | `ep-fancy-firefly-zacgehbx.c-2.eu-west-2.aws.neon.tech` | `forge_migration_rehearsal` | Expires 2026-10-29 15:30:00 UTC |

The persistent staging branch was originally a schema-only root. The current
rehearsal replaces an expired disposable branch and is an expiring child of
isolated staging; its distinct rehearsal database started empty. Earlier
checkpoint references below describe the retired rehearsal. Before reuse, read-only SQL
confirmed the isolated branch/database identities and empty application data. New empty
databases avoid adopting the rowless schema-only copy's empty migration journal.
At the original checkpoint, staging and rehearsal applied all 29 then-checked-in
migrations. The latest checkpoint below advances both current targets to 37. No production rows were copied, no branches were manually
deleted, and the default branch/application connection selection was unchanged.

Staging is a database foundation. Hosted web/runtime, isolated object storage,
OAuth clients, provider sandbox credentials, fixture lifecycle and deploy guards
remain FOR-27 work. Existing test-branch `neondb` databases are separate from the
two named databases above.

## Operator entry point

Run `bun run db:migrate` from `apps/forge` with an explicitly selected direct
`DATABASE_URL_UNPOOLED` and all four identity fields:

* `FORGE_MIGRATION_ENVIRONMENT`: `staging` or `rehearsal`.
* `FORGE_MIGRATION_BRANCH_ID`: the exact checked-in branch ID.
* `FORGE_MIGRATION_HOST`: the exact direct hostname.
* `FORGE_MIGRATION_DATABASE`: the exact database name.

Supply the credential privately from the Neon connection manager or deployment
secret store. Do not paste a connection string into tickets, documentation or
logs. Explicit process values take precedence over local environment files. The
runner does not modify local connection files. Application traffic continues to
use pooled URLs; migrations use a dedicated direct connection.

`scripts/lib/database-targets.ts` allows only the verified isolated targets.
Changing an environment name cannot turn a production connection into an allowed
target. The runner compares actual SQL branch/database identity before any DDL.
`db:push` now exits with instructions to generate a versioned migration. Direct
invocation of external tools remains an operator privilege outside this script;
production deployment credentials must not be available to untrusted build jobs.

## Serialization and failure behavior

One connected PostgreSQL session acquires advisory lock `646735021` **before**
reading the journal. A competing runner fails with `MIGRATION_BUSY`. The owner
validates that every applied hash/timestamp is an exact prefix of the release
files; missing, edited, extra or out-of-order history fails closed. The runner
wraps pending statements and journal writes in one transaction, with a five-second
lock timeout and five-minute statement timeout. Closing the session releases the
lock after a crash. No model, mail or payment calls run inside this transaction.

A failed migration rolls back its schema/data and receipt. A lost connection at
commit has an unknown outcome until the journal is re-read; retrying identical
files either applies the absent transaction or reports zero pending migrations.
Do not edit an applied migration. Add an expansion migration, deploy code that
supports both schemas, run resumable keyed backfills separately, verify counts,
then contract only after old app versions and durable jobs drain. This runner
does not make arbitrary destructive SQL or a long backfill safe.

The CLI redacts driver error details, which can contain private SQL values.
Inspect the migration journal on the explicitly verified target after any failed
or interrupted run; never interpret a timeout as proof of rollback.

## Verified evidence and remaining release checks

`serialized-migrations.postgres.test.ts` applied the real migration history to the
dedicated database. Three PostgreSQL cases passed:

1. Two independent connections competing for an appended migration yielded one
   owner, one busy rejection and one journal receipt; replay applied zero changes.
2. An injected SQL failure rolled back the fixture mutation and its journal row.
   Correcting the unapplied migration applied exactly once; retry was a no-op.
3. Edited applied history was refused before new migration work.

Three safety unit cases cover exact target matching, pooled/wrong hosts/databases,
an attempted production branch under a rehearsal name, and actual branch mismatch
before locking or DDL. Fixture cleanup removes only the invocation's random table
and exact hashes. No live database objects are reset by the tests.

FOR-28 remains In Progress: full old/new app rollback compatibility, resumable
backfill recovery and the hosted staging release rehearsal are still required.
FOR-27 remains In Progress until all staging resources and provider identities are
isolated. Neither passing helper tests nor the existence of a staging database
closes those release contracts.

Billing-grace expansion and provider-subscription binding (0027/0028) have since been applied to staging and rehearsal; both now contain the complete 29-migration history. The three migration fault/ownership cases passed again. The shared read path was also verified against the prior table schema without writes. Production execution remains disabled.

Migration 0029 adds the frozen scheduled-cancellation boundary and updates the counter helper. It was applied only to isolated staging/rehearsal, now 30 migrations. The complete-history migration ownership/failure cases passed again.


## Full-refund migration follow-up · 28 October 2026

Versioned migration 0030 adds the retained refunded-period history and updates member admission to deny refunded paid capacity. All 31 migrations are applied on the exact isolated staging and rehearsal targets. Three serialized migration ownership/fault cases pass against the complete history. The serving/default database is unchanged and still lacks the new production-readiness expansions; production rollout remains separately gated. See `docs/subscription-refunds.md`.


## Immediate termination migration follow-up · 28 October 2026

Migration 0031 adds finite provider-backed terminal state and makes SQL member admission deny paid capacity immediately on final revocation. All 32 migrations are applied only to isolated staging and rehearsal; three serialized ownership/fault cases pass against the complete history. Thirty-one billing-state and fifteen real-auth member cases pass on staging. Existing members stay authorized. No serving/default database or connection configuration changed. See `docs/subscription-termination.md`; production rollout remains separately gated.


## Upgrade-refund access migration follow-up · 28 October 2026

Migration 0032 records paid Plus grant identity and aligns refund-aware Starter fallback with SQL admission. All 33 migrations are applied only to isolated staging/rehearsal; three full-history migration ownership/fault cases pass. Staging: 43 billing and 16 real-auth membership cases pass, including temporary admission refusal without base proof and resumed paid Starter admission after verification. Existing member sessions are preserved. The serving/default database and local connection files are unchanged. See `docs/subscription-plan-changes.md`.


## No-pause migration follow-up · 29 October 2026

Migration 0033 adds a finite provider-backed unsupported-pause cutoff and aligns SQL admission with shared access policy. A fresh empty rehearsal database on the current expiring branch applied all 34 migrations; all 3 ownership/fault cases passed. Only then did the exact persistent staging target apply the one pending migration, now also 34. Current staging tests pass 52 billing and 17 real-auth membership cases. No serving/default database or local connection setting changed; no branches were manually deleted. See `docs/subscription-pause-policy.md`.


## Renewal-currency request migration · 29 October 2026

Migration 0034 adds the durable currency-request history, one-pending-intent index and finite-boundary/fixed-seven-day-deadline constraints. The isolated rehearsal database passed all 35 migrations and 3 full-history ownership/fault cases; exact persistent staging then applied the one pending expansion, now 35. Staging passes 58 billing and 17 real-auth member cases. This does not execute a currency migration or grant checkout grace; no serving/default database or local connection changed. See `docs/renewal-currency-change.md`.


## Original monthly anniversary expansion · 29 October 2026

Migration 0035 adds nullable original source period, anchor day and next boundary to durable currency intents, with all-null legacy or fully populated finite/range constraints. Original-day capture requires a matching verified source replay and atomic audit; no guessed data backfill is performed. A fresh empty database on br-little-pond-zabdmew3 passed all 36 migrations and all 3 ownership/fault cases. Exact persistent staging then applied one pending migration. Billing (62) and real-auth membership (17) cases pass.

An initial CLI database-create command used unsupported `--branch-id`; the CLI selected the default branch and created a new empty rehearsal database there. Verified SQL showed that exact new database contained zero user objects, then it was removed. No DDL migration, user data or existing serving database was changed. The correct command uses `--branch` and its returned identity must be verified before migration. The isolated allowlist and actual-SQL identity checks remained mandatory throughout.


## Atomic active-team capacity expansion · 29 October 2026

Migration 0036 adds/backfills workspace_team_capacity, effective-plan SQL parity and universal team write triggers. Existing teams are retained, including over-cap grandfathered workspaces. Shared workspace fencing uses NO KEY UPDATE to remain compatible with concurrent FK KEY SHARE; final-slot admission is atomic and cross-workspace moves lock deterministically. All 37 migrations and 3 ownership/fault cases passed on isolated rehearsal before exact staging applied the one pending expansion. Staging passes 23 team-capacity, 62 billing and 17 real-auth membership cases.

An actual Polar sandbox fixture temporarily populated staging during provider verification. The membership harness correctly refused its empty-database precondition while that fixture existed. After the fixture was verified, period-end cancellation confirmed and only its owned workspace/users cleaned up, all 17 membership cases passed. No safety guard was bypassed, no production migration/deployment ran and no database connection setting was changed. See `docs/workspace-team-capacity.md` and `docs/polar-sandbox-verification.md`.

## Workspace trial expansion · 29 October 2026

Migration 0037 adds immutable workspace trial redemption, its compound entitlement
binding, eligibility/projection triggers and shared read-time SQL expiry. Member
admission now uses the same effective-plan function as team capacity. All 38
migrations and the three ownership/rollback/hash cases passed on isolated rehearsal
before exact staging applied the single pending expansion. Staging passes 12 trial,
62 billing, 23 team and 17 real-auth membership cases. The membership harness still
requires an empty application database and exact current function bodies; its
expected source now includes the 0037 replacement. No guard was bypassed. No
serving database or database connection pointer changed. See
`docs/workspace-trials.md`; public start waits for atomic usage enforcement.
