# Cycle rollover (FOR-69)

FOR-69 adds automatic closure and configurable carryover to FOR-55's canonical
cycles. It uses FOR-64's durable job runner. It does not enable status-based
assignment, due-date assignment, recurrence, or production scheduling.

## Accepted behavior

The product owner accepted these rules on 5 November 2026 in the FOR-69 session:

- A cycle ends after its inclusive end date in its stored IANA timezone. Job due
  time is the following local midnight, using PostgreSQL timezone rules, including
  DST. Existing dates, numbers and timezones remain immutable.
- First enrollment includes the current cycle and future cycles. Already-ended
  cycles remain untouched. Enrollment is persisted once at the first gated
  schedule read, settings save, or scheduler scan; disabling the gate pauses
  execution without resetting that enrollment or deleting work.
- Authorized workspace admins control **Carry unfinished issues forward** in team
  cycle settings. It defaults to on, including for older settings without this
  field. Turning it off still closes cycles and records history.
- Carryover changes the canonical issue's membership, never its identity. It
  includes backlog, unstarted and started issues still assigned to the ending
  cycle. Completed, canceled, duplicate, archived and deleted issues do not move.
- During cooldown, work moves to the next available cycle before it starts. After
  downtime, use the first unexpired following window, skipping elapsed windows.
  If none exists, materialize the next future window using the current schedule;
  do not invent missed historical windows.
- Read the latest committed issue state at processing time. Preserve completions,
  cancellations and manual membership changes. Patch only cycle membership and
  its properties projection. Revision checks reject stale subsequent user edits.
- Freeze membership, revision and status group when closure actually commits.
  Historical lists refer to the same canonical issue IDs and show current details.
  Closing completion/carryover totals use the frozen records, filtered by current
  issue/team access. Archive or soft deletion after closure does not rewrite the
  closing progress. Permanent removal or loss of access can reduce visible totals.

The schedule labels these cycles **Closed** and shows completion/carryover totals.
The numbered view explains the closing snapshot and its actual closure date.
Closed cycles reject new assignments in the database, including other writers.
Existing assignments can still be edited or moved out without rewriting history.
Clients invalidate team issue queries when a refreshed schedule first sees closure.

## Execution and recovery

`cycle-rollover-v1` uses `(team UUID, cycle UUID)` as its durable job identity;
inputs contain only workspace/team/cycle references. Duplicate dispatches converge
on one job. Dispatch scans at most 100 new due cycles and drains at most 20 jobs
per invocation; retained dead jobs cannot starve dispatch of later cycles.

One SQL-only `close` step locks the live workspace, issue graph and team schedule,
then locks current issue rows in ID order. It rechecks the workspace feature gate,
cycle boundary, enrollment and current team policy. Closure, membership snapshots,
revision-conditioned updates, system command receipt/audit/outbox and the job
checkpoint share one transaction. A mismatch or expiry rolls everything back.
No provider request or second lease implementation is involved.

A crash before commit leaves no closure or movement. A crash after commit resumes
from the existing checkpoint. The system history author is **Forge cycles** and
carried issues receive one `issue.cycle.carried` event. FOR-64 owns retry budgets,
lease expiry, dead-letter state, safe inspection and same-job operator recovery.

```sh
bun run jobs run-cycles
bun run jobs inspect <job-uuid>
bun run jobs replay <job-uuid> --generation <observed-generation> --request <request-uuid> --operator <operator-uuid> --reason code-fixed
```

Use an explicit `DATABASE_URL` and `FORGE_ENVIRONMENT`. The CLI returns nonzero
for failed processing. A disabled workspace or team schedule deliberately defers
its original job/checkpoint without consuming retry attempts.

## Release gate

Apply additive migration `0075_cycle_rollover.sql` using the guarded migration
runner before deploying this source. It adds three tenant-bound, primary-keyed,
recovery-captured tables, immutable history and a closed-assignment guard. Retain
these tables, command receipts and job checkpoints on application rollback.

Default behavior is disabled. Enable only selected workspaces through
`FORGE_FEATURE_ROLLOUTS` with `cycleRollover: { mode: "enabled", workspaceIds: [...] }`.
The gated control and generic settings-save boundary enforce the same grant; normal
cycle planning remains available without it. Disabling the feature stops new
closure/movement but preserves readable history and assignment guards.

The optional authenticated `GET /api/internal/cycle-rollover` additionally requires
`FORGE_CYCLE_ROLLOVER_JOBS_ENABLED=true` and `Authorization: Bearer <CRON_SECRET>`
with a secret of at least 32 characters. Unauthorized/disabled requests return 404;
worker failures return a sanitized 503. The endpoint returns only counts.

Configure a one-minute external scheduler only after migration and deployed
acceptance. Trigger an initial scan immediately when enabling, verify team
`enabled_at` enrollment and inspect due jobs. Confirm scheduler freshness and
failure alerts through the owning operations gate (FOR-30). This PR does not
configure a provider scheduler, change production flags, migrate or deploy.

## Verification

The PostgreSQL suite refuses any database except `for69_cycles_test` at
`127.0.0.1:56469`. Start a dedicated PostgreSQL 17 instance with UTF-8 encoding.
It applies the complete migration chain on a fresh database, rehearses 0075 inside
a rolled-back transaction, checks its three primary keys, and removes only its
UUID-scoped fixtures. Never substitute a serving database.

```sh
cd apps/forge
FORGE_ROLLOVER_TEST_DATABASE_URL=postgresql://<local-role>@127.0.0.1:56469/for69_cycles_test bun run test:cycles:rollover
bun run dev:cycles:fixture
```

AT-01 covers repeated rollover, canonical identity, frozen membership/progress,
history, audit and one carryover. AT-02 kills independent Bun workers before and
after commit, then resumes with one effect; it also covers newer user edits and
stale edit rejection. Additional cases cover DST, first enrollment, no-target
materialization, concurrent claims, carryover off, premature closure, tenant FKs,
workspace gating, admin policy commands, private-team filtering and revocation.

The browser fixture renders production components with a clearly labeled simulated
backend. Desktop/mobile layout, setting toggling, workspace gating, member controls
and closure summaries were inspected in Carbon. It is separate from real PostgreSQL
application-service acceptance and does not establish hosted authenticated behavior.
