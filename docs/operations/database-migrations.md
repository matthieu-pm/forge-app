# Database migration ownership and rehearsal

FOR-27/FOR-28 implementation evidence, 28 October 2026. Production execution stays
disabled until FOR-25 verifies the actual serving database and source revision.

## Provisioned targets

| Use | Neon branch | Direct host | Database | Lifecycle |
| --- | --- | --- | --- | --- |
| Persistent staging | `br-autumn-union-za0opf1e`, renamed `staging` | `ep-blue-shadow-zauhwkjz.c-2.eu-west-2.aws.neon.tech` | `forge_staging` | No expiry |
| Disposable rehearsal | `br-square-sky-za2iavfk` | `ep-ancient-resonance-zaeuj9gw.c-2.eu-west-2.aws.neon.tech` | `forge_migration_rehearsal` | Expires 2026-10-28 22:40:11 UTC |

Both branches were originally schema-only roots. Before reuse, read-only SQL
confirmed zero users, organizations, teams and member counters on both. New empty
databases avoid adopting the rowless schema-only copy's empty migration journal.
Staging applied **all 27 checked-in migrations** through `db:migrate`. Rehearsal
applied the complete history too. No production rows were copied, no branches were
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
