# FOR-69 independent review and corrections

PR #67 was reviewed against base `ac2f7ebe54a5374e1f50b8705696aa1d35bb3853`.
Original head: `e40a3c13be55548424fb13eabee3ed0425890c7a`.
Functional fixes: `3f2be6b6a61ffe42c65ecb02d08af7bdbf4eb4e3`.
Initial validated source after import-order cleanup: `38457b682658dc638c2695f2eea679a2e87a1fa0`.
Final integrated application source: `6482191c53dcdb8d3f0463c047875201c62d2efa`.
Main integration base: `3ee6c8544a7bfb0f6bf45f62b3557ead2ef28e6c` (FOR-68).

Two independent read-only reviewers inspected Standards and Specification. Each
re-reviewed the functional fix commit and independently passed the 15 historical
UI/client tests. The final import-only cleanup changes no behavior.

## Standards

One P2 finding, resolved; re-review has zero remaining findings.

- A new settings/numbered view could observe closure with no prior local snapshot,
  propagate it to the existing numbered view and never invalidate its issue query.
  Closure detection now examines every same-team, same-session snapshot before
  propagation. The new regression first reproduced zero invalidations, then passed
  with exactly one invalidation and no repeat on subsequent reads.

No additional actionable code-smell, lease, transaction, tenant-FK or assignment
constraint defect was found. The independent reviewer separately confirmed the
migration-before-deployment boundary; readiness checks were not weakened.

## Specification

Three findings resolved (one P1, two P2); re-review has zero remaining findings.

- **P1:** when all issues carried forward, the source numbered view tested current
  membership for emptiness and hid historical query results behind a planning
  screen. Loading/empty states now use the canonical query. Every creation path,
  including grouped/board controls and the callback itself, honors closed state.
- **P2:** carried historical rows exposed controls that required their current
  membership to equal the historical source. Inline/bulk/dialog edits now use
  ordinary canonical commands and the current issue baseline/revision; membership
  stays in its actual destination. Historical query rows also supply nested data.
- **P2:** older clients omitting the optional carryover setting could reset an
  opted-out team to the default, or fail an unrelated save when rollout was off.
  Omission now inherits the saved value; only unconfigured settings default on.
  Both workspace-gate states and exact command replay have database regressions.

Seven new regression cases reproduce the four defects on the original source.
All now pass. Final focused acceptance includes 45 tests, with 13 real PostgreSQL
scenarios and actual worker termination before/after transaction commit.

## Validation and merge boundary

The [machine-readable evidence](../../operations/for69-acceptance-evidence.json)
records the final source and checks. All 10 workspace graph tasks passed: lint,
typechecks, tests and builds. Tests passed: 2,925 app (715 skipped external or
intentionally gated cases), 4 Workflow, 37 runtime and 28 scheduler. All five agent
fixture evaluations and 18 gates passed. Eve emitted a sandbox teardown warning
after successful evaluations; the command exited zero. Full lint has zero errors
and 644 warnings. Handwritten changed TypeScript formatting and diff checks pass.
Build/prerender and protected Workflow handler verification pass with synthetic
CI-only configuration. Earlier pre-integration timing failures were retried after
confirming macOS maintenance sleep; the final graph used idle-sleep prevention.

The final integration preserves all 156 prior SQL/snapshot files byte-for-byte,
main's 78-entry journal/readiness prefix, and adds rollover as `0078_cycle_rollover`.
Its linked snapshot agrees with the schema; the manifest has 79 entries with exact
hashes/timestamps. The complete fresh PostgreSQL chain and 0078 rollback rehearsal
passed. A real PostgreSQL preflight probe rejected 78 receipts, accepted the exact
79-entry prefix, and rejected an edited receipt. Probe records were rolled back;
all owned workspaces/users/jobs/history/enrollments were removed and the temporary
server stopped.

Both independent reviewers inspected the final staged FOR-65/FOR-68 integration
and found zero new concrete defects. The merge retains recurring/system history
actors, cycle/recurring/inbox job commands and grant-controlled feature ceilings.
No existing table definition changed in the new snapshot.

Existing [browser evidence](browser.json) covers production schedule/settings
components with a simulated backend. The corrected historical-row interactions
are covered by UI integration tests using the real canonical cache and cycle hook;
this is not authenticated hosted acceptance.

Read-only Vercel configuration confirmed automatic Git production deployment and
custom-domain assignment from main, with `apps/forge` using `bun run build`.
The production-only schema preflight inherited from FOR-68 runs before Vite and
cannot be skipped by Turbo build caching. It blocks promotion for missing, edited
or unreachable required receipts; runtime readiness remains strict. The FOR-68
session observed this guard block actual production deployment
`dpl_ZQP9BPQFicbnLm96wNiMgqu34nkz` before bundling. The serving application was
already returning `503 SCHEMA_NOT_READY` before these source merges.

Source merge is distinct from production migration and feature activation. This
session has made no production database/configuration change. Migration 0078,
provider scheduling and hosted authenticated acceptance remain release gates.
The feature remains disabled by default. Final GitHub/Vercel checks on the
published integrated head must pass before merging PR #67.
