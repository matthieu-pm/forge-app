# Atomic workspace member capacity

FOR-153 implements the five-active-member Free limit. All accepted member rows
count, including owner/admin; pending invitation rows do not count. Existing
members keep access when a paid workspace becomes Free above capacity. New joins
are blocked at five or more, and become possible below five. Roles and existing
member retries do not consume new capacity.

## Database invariant

Drizzle migration `apps/forge/drizzle/0026_workspace_member_capacity.sql` creates
`workspace_member_capacity`, backfills counts without removing members, and installs
organization/member triggers. Migration backfill and installation hold write locks
in the same transaction. Run this through **Drizzle migrations**, not `db:push`:
the generated schema alone does not install the custom triggers/functions.

Every successful member insertion atomically increments one workspace counter only
when its current server entitlement allows another member. The conditional UPDATE
serializes concurrent admissions. Rejected inserts and multirow imports roll back
their records and counter changes together. Deletions release capacity; workspace
moves lock counters in a deterministic order and roll back if the destination is
full. Organization deletion safely cascades. The counter's nonnegative constraint
and missing-state failures prevent silent drift. `ON CONFLICT DO NOTHING` retries
do not fire AFTER INSERT and therefore do not consume another slot.

The same invariant covers Better Auth, invite links, approved-domain joins, trusted
admin additions and database-backed imports. It does not depend on a browser plan,
count or transport-specific precheck. Direct database credentials and migrations
are trusted infrastructure: do not expose counter writes or raw SQL to end users.
The internal adjustment function revokes PUBLIC execution. A future restricted
runtime database role will need explicitly reviewed permissions for these trigger
functions and their tables; the current application uses the established database
owner connection.

Active/trialing server entitlements recognize the existing `basic`/`business`
values and the explicit `starter`/`plus` names, plus Enterprise. These names do not
grant any other feature, bypass email verification or replace the planned canonical
plan migration. Missing/unknown/nonactive entitlement state uses Free capacity,
matching the current security entitlement resolver. Dunning/grace changes belong
in the authoritative entitlement projection before billing is enabled.

## Auth and join paths

Better Auth receives the server-resolved plan limit for a friendly preflight.
Its database adapter converts the named database violation into a public
`WORKSPACE_MEMBER_LIMIT` conflict while leaving unrelated failures unchanged.
Invite-link/domain commands expose the same actionable message.

The installed Better Auth version updates an invitation before its inner member
transaction. `handleAuthRequest` wraps the entire acceptance endpoint in a database
transaction and retains the SDK's inner transaction as a savepoint. This permits
its failure handler to restore a refused invitation without querying an aborted
transaction. Unsuccessful responses roll back the outer transaction. The API route
uses this handler. New programmatic invitation-acceptance adapters must preserve
the same complete transaction boundary rather than bypass it with an isolated
SDK call. Existing auth providers and desktop/API-key integrations remain in place.

## Verification

Run `bun run test`, `bun run typecheck` and the changed-file lint checks from
`apps/forge`. The default Vitest suite deliberately skips the live database file
unless explicit test credentials are provided. It never falls back to DATABASE_URL.

`bun run test:member-capacity:postgres` requires:

- `FORGE_TEST_DATABASE_URL`: direct connection to an isolated test branch.
- `FORGE_TEST_DATABASE_HOST`: the exact expected host.
- `FORGE_TEST_NEON_BRANCH_ID`: its exact `br-...` ID, verified inside Postgres.

Use a schema-only branch so the test begins with empty user/organization tables.
The harness rejects the configured application database host, including its direct
and pooled variants, even if that database is empty.
Fixtures include legacy Free and paid workspaces with six members before applying
the migration. Tests exercise actual PostgreSQL concurrency, batch rollback,
cross-workspace moves, role changes, existing-member retries, downgrade boundaries,
trusted admin additions, tampered invitations, real invitation acceptance, invite
links and approved-domain joins. Only UUID-prefixed test fixtures are cleaned up.

For repeated API checks on an already migrated, empty test branch,
`FORGE_TEST_REUSE_MEMBER_CAPACITY=1` is an explicit opt-in: installed trigger bodies
must exactly match the checked-in SQL, counters must be empty and PUBLIC helper
execution must be revoked. This mode does not rerun migration backfill; keep a
fresh-branch migration run as separate evidence. No database objects are dropped
or reset by the test.

Validated on Forge project `raspy-union-96305162`, schema-only branch
`br-square-sky-za2iavfk`, PostgreSQL 18.6. The fresh migration and initial ten
integration cases passed. The final eleven-case suite also covers verified-owner
workspace creation and authorized access after downgrade, using the empty verified
branch with matching trigger bodies. PUBLIC
helper execution was separately revoked/checked there after the initial migration
run. The initial attempt exposed the missing savepoint and an incomplete domain
fixture; both were corrected before the successful runs.

The temporary test branches were created with expiration. The empty first branch
`br-autumn-union-za0opf1e` has since been renamed `staging`, its expiration removed,
and a separate fresh `forge_staging` database created there. All 27 versioned
migrations, including 0026, were applied through the guarded serialized runner.
The second test branch keeps its expiration. Neither the default branch nor local
`.env`/`.neon` connection selection was changed. Credentials are
kept outside the repository and must not be included in evidence artifacts.

## Rollout

Apply migration 0026 to each intended deployment database before releasing the new
auth/join handlers there. Review lock timing for large workspaces and retain the
usual database rollback/restore plan. Do not remove the invariant while relying
on the friendly preflight; it cannot stop concurrent admissions on its own.

The production/default database has **not** received this migration during local
implementation. FOR-112 remains the billing release gate; production readiness
also requires the separate authorization, trial, entitlement and deployment work.
The full eleven-case real-auth/PostgreSQL suite also passed against the fresh
`forge_staging` database after its complete 27-migration history was applied.
This closes the membership implementation contract on isolated staging. The
separate production migration/application rollout remains a release-gate task.


## Payment-grace compatibility · 28 October 2026

The shared access reader and member-capacity invariant honor the confirmed 168-hour renewal grace. Migration 0027 replaces only the counter helper to evaluate paid period/grace timestamps; migration 0028 binds a provider subscription to one workspace. The complete history now has 29 migrations on isolated staging. The twelve-case member/auth suite passes, including a sixth-member acceptance during grace, refusal after expiry with the invitation still pending, and continued authorized access for existing members. Membership and security reads tolerate the previous entitlement schema. FOR-153 remains Done; production rollout and full billing reconciliation remain separately gated.

Scheduled cancellation now uses the same stored cutoff in feature reads, auth preflight and the SQL counter. The thirteen-case real-auth suite additionally proves that an existing sixth member keeps access after term end while a seventh invitation is refused and remains pending. Migration 0029 is applied only to staging/rehearsal; production rollout remains gated.


## Full-refund migration follow-up · 28 October 2026

Versioned migration 0030 adds the retained refunded-period history and updates member admission to deny refunded paid capacity. All 31 migrations are applied on the exact isolated staging and rehearsal targets. Three serialized migration ownership/fault cases pass against the complete history. The serving/default database is unchanged and still lacks the new production-readiness expansions; production rollout remains separately gated. See `docs/subscription-refunds.md`.


## Immediate termination migration follow-up · 28 October 2026

Migration 0031 adds finite provider-backed terminal state and makes SQL member admission deny paid capacity immediately on final revocation. All 32 migrations are applied only to isolated staging and rehearsal; three serialized ownership/fault cases pass against the complete history. Thirty-one billing-state and fifteen real-auth member cases pass on staging. Existing members stay authorized. No serving/default database or connection configuration changed. See `docs/subscription-termination.md`; production rollout remains separately gated.


## Upgrade-refund access migration follow-up · 28 October 2026

Migration 0032 records paid Plus grant identity and aligns refund-aware Starter fallback with SQL admission. All 33 migrations are applied only to isolated staging/rehearsal; three full-history migration ownership/fault cases pass. Staging: 43 billing and 16 real-auth membership cases pass, including temporary admission refusal without base proof and resumed paid Starter admission after verification. Existing member sessions are preserved. The serving/default database and local connection files are unchanged. See `docs/subscription-plan-changes.md`.
