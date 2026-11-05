# FOR-68 review and merge verification

Review baseline: `ac2f7ebe54a5374e1f50b8705696aa1d35bb3853` (main).
Original PR head: `12afa68a9f72c1b2c816c2a2a153b8743a0cd090`.
Fixed source: `eef413dcd37b5a740df2a240d6462a1a5655148a`. User authorized review, fixes and merge after checks pass; production rollout remains a separate gated step.

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

## Final checks

The complete workspace graph passed: **10 successful tasks**, with app/runtime typechecks, builds and repository-wide lint. Command: `VITEST_MAX_WORKERS=2 bunx turbo run lint typecheck test build --concurrency=1 --env-mode=loose --summarize`, using the same synthetic build-only database/auth settings as CI. Loose mode passes the worker limit through Turbo; task concurrency was reduced to keep this shared desktop's UI tests within their normal budgets.

- App: **2,893 passed**, 678 environment-gated/skipped.
- Workflow: **4 passed**.
- Agent runtime: **37 passed**.
- Loop scheduler trigger: **28 passed**.
- Runtime fixture evaluations: **5 passed; all 18 gates passed**.
- Full repository lint: **zero errors**, 630 existing/conservative warnings.
- TypeScript, both service/app production builds, schema/readiness consistency, protected Workflow handlers, formatter and diff checks passed.
- Source reviewed and checked: `eef413d`. The evidence-only commit does not alter implementation.

Dedicated acceptance passed **48 tests** across recurrence PostgreSQL, editor/settings, calendar/contracts and schema checks. The local database used the complete migration chain through 0076. Temporary fixture counts were zero for organizations, users, schedules, occurrences, events, background jobs and receipts; the PostgreSQL server was stopped.

[Deletion after confirmation](deletion-reconciled.png) shows the actual recurring list after deletion in the labelled synthetic-save browser fixture. Native component tests additionally verify the actual settings parent/list interaction. This is UI verification separate from canonical PostgreSQL acceptance.

## Merge and release boundary

The PR must merge only after the final source checks pass and its remote head matches the validated branch. No hosted checks were registered when review began; Vercel Preview Comments later reported success. The remote head and hosted checks are checked again after the review push and before merge. Production migration/deployment and live scheduler qualification are not claimed. Apply migrations 0075 and 0076 through the guarded release process before enablement; recurring rollout remains disabled by default.

Standards: one finding fixed. Specification: two findings fixed, including the overlap. Two distinct review defects; no outstanding review blockers.
