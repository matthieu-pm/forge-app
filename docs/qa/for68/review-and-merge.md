# FOR-68 review and merge verification

Review baseline: `ac2f7ebe54a5374e1f50b8705696aa1d35bb3853` (main).
Original PR head: `12afa68a9f72c1b2c816c2a2a153b8743a0cd090`.
Final validated source: `79f238e5793ebf06a1e5418dd17f2a17305478d2`. User authorized review, fixes and merge after checks pass; production rollout remains a separate gated step.

## Standards

One P2 finding: successful deletion invalidated the router but did not reconcile the component-owned recurring list. The row/count remained stale, and a second delete conflicted. This violated the authenticated server-projection/reconciliation conventions in `docs/operations/canonical-issues-and-server-storage.md`.

Fixed in `b3bbc2d`: the confirmed delete invokes the parent reconciliation callback before best-effort router refresh. Protected-session and unmount fences prevent stale UI callbacks. Tests cover both normal refresh and refresh failure.

Independent re-review: **no remaining blockers**. The reviewer inspected deletion lifecycle, migration immutability, skip-range matching and transaction boundaries. A further read-only review of the completed evaluation-harness fix also found no blockers.

## Specification

Two P2 findings (one overlaps Standards):

1. A temporal edit could select an occurrence date that had already been skipped during a disabled period. Skipped ranges were only audit events, while cursor exclusion examined occurrence rows. Reproduced with a daily schedule disabled across its old local execution time, then enabled and moved to a later time that same day. This violated the accepted disabled-period/no-resurrection policy.
2. Confirmed deletion left the management list stale, as described above.

Fixed in `b3bbc2d`: additive migration 0076 freezes each skipped range's original anchor, interval, unit and index bounds. Temporal edits and direct occurrence reservations consult that identity. Gaps between weekly/monthly dates remain eligible. Historical ranges without cadence metadata conservatively retain their exclusions. Migration 0075 is unchanged.

Independent re-review: **no remaining blockers**. Pending snapshots, disable/resume, monthly clamps, migration guards and deletion fences were checked.

## Reproduction and additional fixes

- The original PR source failed three new regression cases: one PostgreSQL disabled-date/time-edit case and two real component deletion cases, including router refresh failure.
- Two schema boundary regressions also failed before refinement: accepted dates/cadences whose next occurrence exceeded the supported calendar. The validator now rejects them before an immutable save intent is written, allowing immediate repair.
- Corrected historical downtime fixtures to rewind their owned activation state explicitly. They previously reused dates already marked skipped before activation; the stronger no-resurrection guard correctly exposed that inconsistency.
- The wider CI run exposed a pre-existing runtime evaluation harness problem: its temporary service copy omitted the relative workspace packages. `run-evals.mjs` had identical hashes on main and the original PR. `65bec92` preserves the temporary workspace layout/dependency links and binds authored workspace imports through Eve's nested service snapshots. The real evaluation now passes all five scenarios and 18 gates, using fixture models only. The existing Eve sandbox-shutdown warning remains non-fatal.
- `eef413d` resolves full-workspace lint errors in fixture import order, the new database import location and an ineffective stray API-key-settings expression. These are formatting/dead-expression changes.

## Hosted build regression

Vercel's preview exposed a Workflow bundling failure that the default Node preset did not exercise: recurring authorization imported the full issue service, transitively pulling TanStack request code and unresolved virtual imports into invitation Workflow steps. The failed hosted preview at `f8905c8` was reproduced locally with `VERCEL=1 bun run build`.

`25fe171` extracts the existing `requireIssueTeam` into a lightweight server policy module and retains its issue-service re-export. The policy body is unchanged, including both scope checks and both `FOR SHARE` locks. Independent re-review found no blockers. The same Vercel-preset build now succeeds, including packaged OIDC dependencies and protected Workflow verification. All 17 dedicated recurrence PostgreSQL tests pass after extraction. Both hosted app/runtime previews also reached READY at `25fe171` (`dpl_FQxTPAYEqWtrwU1uENBwyV2DKsNX`, `dpl_BY4UJefDdeYKsoTFPeqkzvkBgFRx`). `91b837b` removes the leftover unused team import and sorts the new module import. All hosted statuses must be rechecked on the final PR head before merge.

## Final checks

The complete workspace graph passed: **10 successful tasks**, with app/runtime typechecks, builds and repository-wide lint. Command: `VITEST_MAX_WORKERS=2 bunx turbo run lint typecheck test build --concurrency=1 --env-mode=loose --summarize`, using the same synthetic build-only database/auth settings as CI. Loose mode passes the worker limit through Turbo; task concurrency was reduced to keep this shared desktop's UI tests within their normal budgets.

- App: **2,893 passed**, 678 environment-gated/skipped.
- Workflow: **4 passed**.
- Agent runtime: **37 passed**.
- Loop scheduler trigger: **28 passed**.
- Runtime fixture evaluations: **5 passed; all 18 gates passed**.
- Full repository lint: **zero errors**, 630 existing/conservative warnings.
- TypeScript, both service/app production builds, schema/readiness consistency, protected Workflow handlers, formatter and diff checks passed.
- Full graph originally verified at `eef413d`; repeated after policy extraction/import cleanup at `91b837b`. Evidence-only commits do not alter implementation.

Dedicated acceptance passed **48 tests** across recurrence PostgreSQL, editor/settings, calendar/contracts and schema checks. The local database used the complete migration chain through 0076. Temporary fixture counts were zero for organizations, users, schedules, occurrences, events, background jobs and receipts; the PostgreSQL server was stopped.

[Deletion after confirmation](deletion-reconciled.png) shows the actual recurring list after deletion in the labelled synthetic-save browser fixture. Native component tests additionally verify the actual settings parent/list interaction. This is UI verification separate from canonical PostgreSQL acceptance.

## Merge and release boundary

The PR must merge only after the final source checks pass and its remote head matches the validated branch. Vercel Preview Comments alone does not prove a successful app build. The app and runtime deployment statuses and GitHub check rollup are checked on the final remote head before merge. Production migration/deployment and live scheduler qualification are not claimed. Apply migrations 0076 and 0077 through the guarded release process before enablement; recurring rollout remains disabled by default.

Standards: one finding fixed. Specification: two findings fixed, including the overlap. Two distinct review defects; no outstanding review blockers.

## Main integration

Main advanced to `dff9e6e` (FOR-65/shared inbox) while the final review checks were completing. Its migration 0075 is preserved byte for byte. The two still-unreleased recurrence migrations were moved to 0076 and 0077 with unchanged SQL. Their snapshot chain now includes the inbox schema and the readiness manifest was regenerated; Drizzle reports no schema changes. Both inbox and recurrence CLI dispatch and schema registrations were retained. Historical evidence above records the original migration numbering. Final acceptance is rerun on a fresh local database through 0077, together with the full combined workspace graph and final-head hosted checks.

## Production promotion guard

Main's automatic Vercel promotion was verified during reconciliation. Before FOR-68 merge, the existing production endpoint returned `503 SCHEMA_NOT_READY` on `dff9e6e`. `79f238e` adds a production-only read-only preflight before Vite bundling, reusing `schemaIsReady`'s exact required migration prefix with bounded Neon queries and sanitized failure output. It never applies migrations. Preview/local builds skip the database check.

Seven promotion cases plus nine runtime readiness cases pass. Direct package build and root strict-env Turbo build with missing production credentials both exit 1 before bundling, as intended. Independent review found a possible Turbo cache bypass; app build caching is now disabled and the actual root rejection log verifies cache bypass. Re-review found no remaining blockers. Production promotion stays blocked until the separately authorized migration chain is recorded; the current production deployment and database were not changed by this work.

## Final combined-source results

At `79f238e`, after integrating main `dff9e6e` and the production promotion guard, all **10 workspace tasks passed** (one cache hit). App: **2,912 passed / 702 environment-gated skipped**; Workflow: **4 passed**; runtime: **37 passed**; scheduler: **28 passed**. Lint: **zero errors / 632 warnings**. All typechecks and builds passed. Turbo summary: `3LhgqHeifkOXPLJXHiXYurTiVU3`. The 17 PostgreSQL recurrence cases were rerun on the freshly rebuilt complete chain through 0077; all fixture counts returned to zero and the server was stopped.

Both hosted previews reached READY at that source: app `dpl_D87aEdigz8Dzck1rPgYHGkzvmkVu`, runtime `dpl_TWEkTSHTritnQqWrJyEuEVC7Rmwa`. All three GitHub checks passed. Final evidence-only head checks are revalidated before merge. No review blockers remain. Production source promotion remains guarded separately; this is not evidence of production migration, hosted authenticated acceptance or live scheduler qualification.
