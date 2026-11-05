# FOR-68 acceptance · 5 November 2026

Implementation commit: `529186a9cbba8743bfdb92648b5113aa3f78d29d`.
Base: `ac2f7eb`. Branch: `mengde/for-68-generate-one-canonical-issue-for-each-recurring-occurrence`.

The product decisions are recorded in [the runbook](../../operations/recurring-issues.md) and on [FOR-68](https://linear.app/atriumcrm/issue/FOR-68/generate-one-canonical-issue-for-each-recurring-occurrence).

## Contract evidence

| Contract               | Environment and result                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01 / AT-01          | Passed on dedicated local PostgreSQL 17. Two workers receive the same occurrence/job across both Paris DST transitions. One canonical root issue is committed, with the frozen local date and expected UTC interpretation: spring 02:30 → 01:30 UTC; autumn 02:30 → 00:30 UTC. Duplicate dispatch and duplicate save commands also retain one result.                                                                  |
| AC-02 / AT-02          | Passed on dedicated local PostgreSQL. Downtime selects only the latest missed date; older dates are recorded as skipped ranges. Disable cancels pending work; resume moves to future dates without backfill. Legacy definitions remain inactive until activation. Lost owner access pauses generation; explicit admin ownership resumes future work.                                                                   |
| Recovery and revisions | Frozen template content survives edits and duplicate execution after a committed checkpoint. An injected PostgreSQL trigger interruption rolls back the issue and leaves the same occurrence pending; retry creates one result. Invalid nested references roll back the entire setup. Current nested status/assignment/content are preserved. Stale edits conflict. Temporal edits retain one identity per local date. |
| Gates and fairness     | Disabled/deleted schedules do not create pending work. An unavailable workspace cannot consume all 100 dispatch slots ahead of enabled workspaces. Worker dispatch/claims filter the enabled workspace set and recheck live gates/owner access.                                                                                                                                                                        |
| Client retry           | Component tests cover immutable save replay after lost response and remount, server-confirmed validation repair, title/date validation, management controls and nested draft protection.                                                                                                                                                                                                                               |

## Validation

- Final app suite: **2,888 passed**, 676 environment-gated/skipped tests; 364 files passed and 35 skipped. Command: `bunx vitest run --maxWorkers=2 --testTimeout=30000`.
- Dedicated acceptance: **26 passed** across PostgreSQL recurrence, editor and calendar suites. Local target guard: `127.0.0.1:56468/for68_recurring_test`; full repository migration chain applied on this disposable database. No cloud/customer database was used.
- Workflow: **4 passed**.
- App TypeScript: passed.
- Production build, prerender and protected Workflow handler checks: passed with synthetic local-only build settings.
- Changed implementation lint: **zero errors, 21 warnings**, including existing template warnings and conservative nullable-row checks. Prettier and `git diff --check` passed.
- The initial broad run found a stale generated readiness manifest while the build was regenerating it. The manifest was refreshed; all 11 readiness/schema checks passed, followed by the clean final full-suite result above.
- Fixture cleanup verified zero organizations, users, schedules, occurrences, recurrence events, jobs and receipts. The temporary PostgreSQL server was stopped.

## Browser evidence

Carbon inspected the actual editor/list in the labelled local UI fixture at `http://127.0.0.1:3168`. Synthetic save transports are explicit in the fixture banner. Saved state, ownership/activation controls, skipped-range explanations, desktop layout and 390px mobile scrolling were inspected. A fresh browser load reported no errors.

[Desktop activity](desktop-activity.png) · [Mobile activity](mobile-activity.png) · [Mobile controls after scroll](mobile-controls.png).

Run the fixture using `bunx vite --config scripts/fixtures/recurring/vite.config.ts` from `apps/forge`. Browser evidence verifies controls/layout separately from the real PostgreSQL canonical-command evidence.

## Release boundary

Rollout remains disabled by default. No production migration, deployment, hosted authenticated acceptance or live scheduler registration/cadence is claimed. The opt-in CI tick and operator command are implemented; Operations must configure and prove the actual schedule before enablement. Apply migration 0075 through the guarded release workflow and verify grants and exact source before enabling allowlisted workspaces. Cycle selection is outside this slice and remains unavailable; generation uses canonical issues without a cycle requirement.
