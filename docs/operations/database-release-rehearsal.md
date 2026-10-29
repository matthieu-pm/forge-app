# Expand-and-contract release rehearsal (FOR-28)

This is a reproducible release protocol using synthetic records in a random
`for28_<run UUID without hyphens>` schema on the exact isolated staging database.
It exercises real PostgreSQL DDL, three version-specific application adapters,
bounded resumable data movement and hosted immutable Forge deployments. Product
tables and the product migration journal are untouched. The evidence file records
the tested source, deployments, database identity and results.

## Safety and ownership

The existing exact direct-host/database allowlist and actual SQL branch identity
checks apply before migration, backfill, retirement and cleanup. Production stays
excluded. Rehearsals use their own versioned journal with the same global migration
owner lock as product migrations. A competing owner exits with `MIGRATION_BUSY`.
Schema, data changes and migration receipt commit together. Never run `db:push`.

Each invocation requires a lowercase UUID v4. Identifiers derive only from that
validated ID; values use bound parameters. Cleanup verifies the schema's owner
record, takes the exclusive lock and drops only that run's schema. A separate
sentinel invocation must survive. The web database role gets only schema usage,
release-registry reads and synthetic-record DML. It gets no DDL, checkpoint or
retirement permissions.

## Compatibility phases

1. **Prior:** `records(id, legacy_value)` and old application SQL. Seed five
   synthetic rows, or write through the old hosted adapter.
2. **Expand:** add nullable `value_v2`, install a transactional synchronization
   trigger, capture the backfill's upper key, and deploy the bridge adapter.
   The bridge reads `coalesce(value_v2, legacy_value)` and writes the old column.
   The old adapter still mentions only `legacy_value`. The new adapter mentions
   only `value_v2`. The trigger preserves both old-only and new-only writes,
   including inserts after the captured upper key and old updates to rows already
   backfilled. Neither a rollback nor a concurrent old writer can stale the new
   projection.
3. **Backfill:** one invocation processes one keyset chunk (default 2, maximum
   1,000). Row changes, cursor and completion flag commit in the same transaction.
   Five-second lock and 30-second statement timeouts bound each attempt. A source
   digest binds the checkpoint to the exact transformation; changed source refuses
   resume. Restart on another connection from the durable cursor. A completed job
   is a no-op. Writes above the upper key are covered by the expansion trigger.
4. **Application rollback:** promote old → bridge → old on the staging alias.
   Read bridge-written data with the old application and write with the old
   application again. Both compatible builds must agree. Keep the expanded schema
   and full migration history; do not invoke an older migration manifest or try
   to reverse the expansion on application rollback.
5. **Retire:** deploy and verify the new adapter after completion. Each application
   operation holds a shared transaction lock and reads its release permission
   before record access. Retirement takes the exclusive lock, drains in-flight
   operations and permanently disables old/bridge versions for this run. Their
   immutable hosted endpoints and jobs cannot re-enrol or read/write records.
6. **Contract:** require disabled old/bridge readers/writers, the matching completed
   checkpoint and exact old/new data equality in the migration transaction. Only
   then remove the synchronization trigger and legacy column and require a
   non-null new value. Retry identical files applies zero additional migrations.
   After this boundary only the new adapter is a supported rollback target.

The release registry is enforceable for these adapters, not an inventory of every
consumer of arbitrary product tables. A product contract release must supply its
own verified web, desktop, runtime and durable-job retirement evidence and enforce
the same fencing (or revoke old database access). No generic SQL parser certifies
arbitrary destructive migrations. This rehearsal accepts the platform protocol,
not every future schema change or a production promotion.

## Run locally against isolated staging

Supply an explicitly selected direct `FORGE_FIXTURE_DATABASE_URL` privately from
the Neon connection manager. Do not change root application connection pointers.
From `apps/forge`, using the same generated UUID in every command:

```sh
bun run db:rehearse prior <run-uuid>
bun run db:rehearse expand <run-uuid>
bun run db:rehearse backfill <run-uuid> 2
```

Repeat the bounded backfill command until `complete: true`. Inspect the exact
run journal/checkpoint after an unknown commit outcome; retry is safe. Contraction
before retirement must fail. After compatible application rollback has passed:

```sh
bun run db:rehearse retire <run-uuid>
bun run db:rehearse contract <run-uuid>
bun run db:rehearse cleanup <run-uuid>
```

The real PostgreSQL test injects a failure after row UPDATE and before checkpoint
commit; data and cursor roll back together. It also verifies independent ownership,
retry, late old writes, rollback writes, in-flight retirement refusal, disabled
reader refusal, actual column removal, new-only writes, sentinel preservation and
unchanged product migration history. Unit tests cover target denial before
mutation, changed-source refusal, identifier/batch bounds, and probe authorization.

## Hosted rehearsal

Use the existing staging web project only. The endpoint
`/api/internal/database-release-rehearsal` is disabled by default and always denies
production. Configure per-deployment variables, never project-wide defaults:

* `FORGE_DB_REHEARSAL_RUN_ID`: the same invocation UUID.
* `FORGE_DB_REHEARSAL_TOKEN_SHA256`: SHA-256 of a random 32-byte base64url token.
* `FORGE_DB_REHEARSAL_EXPIRES_AT`: UTC timestamp within the next two hours.

`bun scripts/deploy-staging.ts web --rehearsal old|bridge|new` requires a clean
committed snapshot and pins the staging project/team explicitly. It creates a
production-slot deployment **inside the staging project**, with `--skip-domain`.
The launcher pins JavaScript CLI 50.4.11: native CLI 65.7.0 ignored `--skip-domain`
and custom metadata during verification, although runtime overrides arrived.
The selected version is immutable deployment configuration; all three adapters
belong to the same reviewed source revision. Record all deployment IDs and version
metadata. Promote/roll back only this staging project's stable alias to perform
the rehearsal; restore its original deployment afterward.

Authenticated GET `?id=1` reads; POST `?id=1&value=synthetic-value` writes then reads.
Send `Authorization: Bearer <raw token>` and a random 32-hex-character
`x-environment-check-challenge` header. Responses echo the challenge, run, source
revision, immutable deployment ID and application version. Verify all identities.
Vercel protection still requires a staging-only automation bypass; do not disable
SSO. Create it only on the explicitly named staging project and revoke it on exit.
The raw probe token stays local. Invalid/expired configuration or authority denies
before database initialization; driver details are redacted.

Finally retire readers, contract, verify new-only read/write, remove only owned
fixture schemas, restore the original staging alias, revoke the staging bypass,
destroy local tokens and verify anonymous access still goes to Vercel SSO. Per-build
probe hashes expire automatically and no future project environment settings are
changed. Attach the resulting sanitized evidence before closing the issue.
