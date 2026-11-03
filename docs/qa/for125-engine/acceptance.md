# FOR-125 engine review and acceptance

Tested source: `65245c984e00beb5315db10ab3c3f877a0e3f348`, incorporating main
`7e8cd5c2662abebb876c22fc002bd557d120f76a`. The merged
[contract](../../shared-sla-contract.md) defines this implementation. This
evidence supplements the earlier documentation-only PR #52 release record.

## Standards

No owning documented coding-standard violations were found. Independent review
identified two P2 correctness issues: status IDs lacked team scope, and stale
interruption classifications lacked a version precondition. Both were fixed.
Status references now carry `(teamId,statusId)` throughout the UI, validation and
SQL. Interruption classifications require the exact observation token under lock;
successful command replay still returns its receipt without repeating effects.

Re-review found one further P2: handling an invalid condition silently adopted
the latest policy revision while keeping the old draft. The fix refreshes only
directory metadata and retains the original revision, so concurrent changes
require the existing explicit conflict choice. Final independent re-review at
`4d206a7` found no remaining material Standards findings.

## Spec

Independent review found three P2 issues, all fixed: an observed feature-off
interval before deadline could be forgotten; SQL rejected case-insensitive IANA
spellings already accepted by team settings; and a definitive invalid-condition
response left the draft locked in ambiguous-save retry mode. Uncertain intervals
are now retained, valid team timezones resolve to canonical PostgreSQL names,
and typed validation results preserve editable drafts. The source fallback also
uses a process identity because a source revision alone cannot establish
availability continuity across independent processes.

The silent-rebase issue was also identified on this axis and corrected as above.
Final independent re-review at `4d206a7` found no remaining material Spec findings.
Totals: three Standards findings and four Spec findings, six unique findings;
the worst priority within each axis was P2, and all are resolved.

## Acceptance

AC-01/AT-01 and AC-02/AT-02 core engine checks passed on a disposable local
PostgreSQL 17 database: 20 actual PostgreSQL/application-service tests plus four
admission/schema tests, no targeted skips. The fixtures cover work weeks, DST
gaps/folds, anchors, ordered rules, immutable snapshots, due-date exclusivity,
non-pausing states, lifecycle transitions, disablement and owed obligations,
reopening, cross-tenant/admin checks, team-scoped statuses, exact completion
precision, and atomic rollback. Independent worker processes were killed before
and after the actual breach checkpoint; recovery produced one event/history row.

The complete app suite passed 2,660 tests in 337 files; 649 tests in 33 files
requiring other database/provider/host fixtures were skipped. Four Workflow tests
also passed. Typecheck, production build, protected Workflow verification, schema
drift generation and diff checks passed. ESLint on changed application files had
zero errors and 42 non-blocking warnings, including existing touched code and
dynamic SQL guards. All 73 migrations replayed on a fresh database and the second
replay was a no-op. The six SLA tables have primary keys, immutable identities
and recovery triggers; the deferred issue FK was independently inspected.

Six built-app browser scenarios passed with real Better Auth sessions and two
accounts. They cover policy save, explicit conflict resolution, a concurrent
policy update combined with a stale condition, a lost response after commit and
same-receipt retry, live admin revocation, and member issue creation/reload with
system history. The accounts use Honolulu and Tokyo device timezones; the member
clock is set to 2040. The saved anchor remains database-owned, server risk stays
correct, and the deadline displays in the captured Europe/Paris timezone. There
were zero page errors. One intentional transport abort exercises uncertain-save
recovery. Visual inspection also caught and corrected the initial use of device
time beside a team-timezone label.

[Structured evidence](acceptance.json), [browser results](browser.json),
[issue screenshot](issue-sla.png), and the
[operations guide](../../operations/shared-sla-engine.md) describe the exact
scope and reproduction commands. Fixture cleanup left zero workspaces, policies,
commitments or SLA jobs in the disposable database.

This PR implements the core deadline/breach engine behind default-off workspace
rollout and policy controls. It applies no production migration, changes no
production settings and performs no production deployment. FOR-65/FOR-145
notification delivery remains a conditional extension; packaged macOS and
production throughput qualification are not claimed.
