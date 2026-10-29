# Tenant-safe database relationships (FOR-31)

The canonical database owns resource UUIDs and workspace bindings. A relation can
connect only resources in the same workspace. These invariants run for application
commands, imports, jobs and direct SQL, independently of adapter validation.
FOR-21 supplies the visibility decisions; FOR-39 owns the complete authorization
rollout. Database consistency does not authorize a database client as an end user.

## Schema and command boundary

`apps/forge/src/db/planning-schema.ts` establishes the identity/relationship
foundation for projects, participating teams, initiatives, initiative projects,
issues, parents, issue relations, labels, issue labels and document origins.
`issues.number` is positive and unique within its team. UUID identity is distinct
from a displayed team identifier. Workspace labels and team labels have separate
scoped name uniqueness. A workspace label may be attached to a private issue;
a team label may be attached only to issues in that team. Changing an issue's
team also checks existing label bindings atomically.

Projects may span public and private teams in the same workspace. Issue parent
links may cross teams in the same workspace. Neither creates an access grant.
Document origin is immutable: a future sharing grant must publish the document
explicitly, rather than erasing its private origin. At most one origin is allowed.

The existing schema now checks workspace/team pairs for memberships, templates,
recurring schedules, meeting connections and Calls. Team membership also references
a membership in the same workspace; revocation cascades that user's team memberships.
Template defaults accept a template in their team or at workspace scope, never a
foreign-workspace or other team's template.

Indirect agent checks bind runs to same-workspace model connections, events to
their actual run/thread pair, approvals and usage reservations to their run's
workspace, capability invocations to their exact approval/run pair, and thread
model preferences to same-workspace connections. Idempotent API receipts bind
to the credential's workspace metadata; that binding and credential owner cannot
be reassigned. Single-owner artifacts, catalog entries, workflow effects and
Call notes/actions retain their immutable owning parent path.

Every current public primary key and workspace/organization scope has an immutable
update trigger. Additional ownership columns are explicitly inventoried in the
migrations. New tables must extend this inventory; the PostgreSQL acceptance suite
fails if any public primary-key table lacks its guard. Resource deletion remains
available through existing cascades. A cross-workspace transfer requires new
identities and a future authorized copy/import flow, not an UPDATE of ownership.
Team/member capacity regressions now exercise this contract and fresh identities.

`application/planning/relationships.server.ts` provides internal `setIssueParent`
and `setIssueProject` commands. Their strict input contains issue/target IDs only.
They require credential read/write scopes, reload and lock current workspace
membership, derive the role from that row, and check both endpoints' visibility.
Workspace owners/admins can read private teams; ordinary members require team
membership. Shared projects remain readable through a participating public team
without allowing private issue parents. Foreign, absent and unreadable endpoints
return the same access error. Constraint errors become a fixed safe relationship
error; raw SQL error detail is not returned. Deadlock/serialization errors remain
transaction failures and require whole-command retry.

These are internal foundations, not enabled public planning endpoints. Existing
browser-local issues/projects/documents are not imported or silently published.
FOR-41/42/44/54 and the document stories own complete product fields and persistence;
FOR-39 owns all read/aggregate/transport policies. Template/recurring JSON remains
validated draft configuration, not a canonical relation or authorization grant.
Opaque workflow subject IDs and API operation keys likewise require their owning
adapter's live resource resolution; the explicit foreign keys and ownership paths
above are the enforced database relationships.

## Parent cycles and concurrent transactions

Each graph edit writes the workspace's `issue_hierarchy_guards` row before walking
the ancestor chain. Its deletion is rejected while the workspace exists, preventing
delete/recreate from manufacturing a fresh mutex for an old graph snapshot. At READ COMMITTED the waiter checks the newly committed chain.
At REPEATABLE READ/SERIALIZABLE a stale updater fails with SQLSTATE 40001 instead
of validating against its old snapshot. This uses an actual row update: an advisory
lock by itself cannot refresh a repeatable-read snapshot. See PostgreSQL's
[transaction isolation rules](https://www.postgresql.org/docs/current/transaction-iso.html).

BEFORE and AFTER row guards reject self/deep cycles and multi-row INSERT/UPDATE
cycles. A recursive UNION terminates even if corrupt pre-existing ancestry were
encountered. The statement/transaction rolls back, retaining the prior non-null
parent and other mutations. Same-workspace cross-team parents remain valid.
The PostgreSQL suite establishes an old snapshot and observes an actual lock waiter
in `pg_stat_activity` before releasing the first writer at all three isolation levels.

## Migration and rollback compatibility

Use the existing serialized `db:migrate` runner with the exact allowlisted target.
0040 adds canonical tables, scoped FKs and trigger guards; 0041 completes membership
and indirect ownership checks; 0042 protects the graph guard lifetime. Applied history is never edited. New readers do
not require extra columns on existing writers. Existing valid writer shapes and
billing/capacity/visibility paths remain compatible; former ownership reassignment
is intentionally rejected. SQL FK validation and indirect-row preflight abort the
whole migration and journal transaction on invalid legacy relationships. They do
not silently repair, remove or publish customer data. DDL locks block competing
writers during installation; use a maintenance window appropriate to table size.

This is an enforcing expansion: rolling the app back does not disable integrity.
A production release must inventory older writers that reassign workspace/identity,
rehearse representative sanitized legacy data, and resolve existing invalid rows
explicitly before promotion. Production execution remains disabled by the existing
runner. Schema availability is reflected in the generated readiness manifest.

Triggers run as the caller; ordinary app roles need DML on the new tables and
EXECUTE on the guard functions. The staging role's owner default privileges cover
new tables. It remains unable to disable triggers, alter schema or bypass integrity.
Do not grant schema ownership to an app login to make these checks pass.

## Reproduce acceptance

Use the approved empty staging database `forge_staging`, branch
`br-autumn-union-za0opf1e`; production URLs are rejected before fixture writes.
Supply a private, mode-0600 JSON file (outside Git) with `connection` (direct
migration/operator URL) and `applicationConnection` (direct staging application URL
for `forge_staging_web`). Both SQL branch/database identities are checked before
fixtures; the application commands run using the actual ordinary app login.

From `apps/forge`, after guarded migrations:

```sh
FORGE_TENANT_TEST_DATABASE_FILE=/absolute/private/database.json \
  bunx vitest run src/db/tenant-integrity.postgres.test.ts src/db/schema-migrations.test.ts
```

The suite creates only random `for31-<uuid>` fixture workspaces and synthetic
`example.test` users, then deletes those exact IDs and descendants. An assertion
verifies workspace cleanup. If interrupted, identify and remove only the recorded
fixture IDs after checking ownership and the actual SQL database/branch. Do not
reset or truncate staging. Remove the private connection file after verification.

The durable evidence file `for31-tenant-integrity-evidence.json` records the named
source, migrations, target, results and final zero-fixture counts. No production
migration, deployment, connection-pointer change or existing local-data import is
part of this acceptance.
