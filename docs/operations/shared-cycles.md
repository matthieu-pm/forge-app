# Shared team cycles (FOR-55)

Cycle windows live in `issue_cycles`. Each window has a canonical UUID, a stable
per-team number, inclusive calendar dates, and an IANA timezone. Issue membership
uses the existing composite workspace/team/cycle foreign key on canonical issues.
The web app sends the UUID; date aliases remain accepted for legacy migration.
Normal issue creation and edits cannot invent a cycle through `cycleImport`.

Workspace admins manage the shared schedule, following the existing team-settings
permission. Authorized contributors assign issues using the standard issue edit
command, expected revision, durable receipt, and conflict/retry interface. A stale
assignment cannot overwrite newer work. Cycle-only source snapshots are retained
for migration, but never rendered alongside canonical issues in shared mode.

## Accepted scheduling behavior

Confirmed by the product owner on 31 October 2026:

- Preserve every existing window, number, timezone, and membership when settings
  change or cycles are disabled. The database rejects changes to window identity.
- Apply changed duration, cooldown, weekday, and timezone to newly created windows.
  Initial enablement starts on the next selected weekday, strictly after today in
  the team schedule timezone. Existing configurations use the team's timezone
  unless an explicit schedule timezone has been saved.
- Maintain the configured number (1–6) of upcoming windows when an authorized user
  reads the schedule or an admin saves it. Creation is serialized per team, and
  unique constraints prevent duplicate dates/numbers. Reads materialize missing
  windows deterministically; there is no background scheduler in this change.
- After a long idle period, create the next future windows instead of synthesizing
  missed historical cycles. No work is silently moved or completed. Rollover,
  carryover, and status-based automation remain FOR-69 / separately scoped work;
  the unimplemented automation controls are disabled.

Current/upcoming/past labels use the stored timezone of each window and inclusive
end dates. Browser timezone and daylight-saving offsets cannot shift dates.
Numbered links stay attached to the same window; `/cycle/upcoming` resolves the
next future window. The schedule reads 100 recent windows plus an explicitly
requested older number. Counts come from authorized canonical issues in one
aggregate query. Browser refresh occurs on focus, issue changes, and every 30 seconds.

## Migration and verification

Apply migration `0060_shared_cycles.sql` through the serialized migration runner
before deploying this app. It backfills numbers ordered by start date and the
team timezone without changing existing UUIDs or dates. The previous application
can still read date aliases; the trigger supplies numbers for its inserts.
The readiness manifest includes the migration hash.

Use a dedicated isolated database; never substitute a production connection.
The checked-in target is `forge_cycles_acceptance` on staging branch
`br-autumn-union-za0opf1e`. The private JSON connection file contains `connection`
(direct migration/fixture credentials) and `applicationConnection` (pooled app role).
Provision/grants follow the existing acceptance runner:

```sh
cd apps/forge
FORGE_CYCLE_TEST_DATABASE_FILE=/private/path/connections.json bun scripts/for41-migrate-acceptance.ts
FORGE_CYCLE_TEST_DATABASE_FILE=/private/path/connections.json bun run test:cycles:postgres
FORGE_CYCLE_TEST_DATABASE_FILE=/private/path/connections.json FORGE_CYCLE_BROWSER_URL=http://localhost:3155 bun run test:cycles:browser
```

The local browser server must use that same isolated app connection, a dedicated
Better Auth URL/secret, valid local service configuration, and personal preference
sync enabled. The browser script creates two accounts/workspace fixtures and
removes only its own records. PostgreSQL acceptance also rehearses 0060 in a
transactional isolated schema containing pre-migration cycle rows.

AT-01 verifies shared IDs, windows/timezone, counts, and member views. AT-02 verifies
revision conflicts, foreign/missing cycle rejection, schedule CAS conflicts,
private-team access and revocation. Calendar tests cover DST boundaries; client
tests cover background-response fencing, workspace changes and exact retries.
No production migration, deployment, or native packaged-client acceptance is
claimed by this PR.
