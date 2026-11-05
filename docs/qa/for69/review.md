# FOR-69 independent review and corrections

PR #67 was reviewed against base `ac2f7ebe54a5374e1f50b8705696aa1d35bb3853`.
Original head: `e40a3c13be55548424fb13eabee3ed0425890c7a`.
Functional fixes: `3f2be6b6a61ffe42c65ecb02d08af7bdbf4eb4e3`.
Validated source after import-order cleanup: `38457b682658dc638c2695f2eea679a2e87a1fa0`.

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
All now pass. Focused acceptance includes 39 tests, with 13 real PostgreSQL
scenarios and actual worker termination before/after transaction commit.

## Validation and merge boundary

The [machine-readable evidence](../../operations/for69-acceptance-evidence.json)
records the final checks and source. The clean sleep-protected full run passed
2,903 app tests (674 environment-gated skips), plus 4 Workflow tests. Earlier
timing failures were independently retried; macOS maintenance sleep was confirmed
and the final run used idle-sleep prevention. Typecheck, production build/prerender,
protected Workflow handlers, changed-file lint (zero errors) and diff checks pass.
All owned PostgreSQL fixtures were removed and the temporary server stopped.
All three GitHub/Vercel checks passed on the validated source.

Existing [browser evidence](browser.json) covers production schedule/settings
components with a simulated backend. The corrected historical-row interactions
are covered by UI integration tests using the real canonical cache and cycle hook;
this is not authenticated hosted acceptance.

Read-only Vercel configuration inspection confirmed the Forge project serving
`app.forgenow.tech` has Git deployments enabled and production branch `main`.
Migration 0075 must precede deploying this application; its new history reads and
readiness manifest require that schema even while rollout defaults off. Merge
approval alone has not been treated as production-database migration approval.
No production migration/deployment, provider scheduler configuration or packaged
macOS acceptance was performed. The feature remains disabled by default.
