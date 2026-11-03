# FOR-129 · PR #56 review and release

Matthieu explicitly authorized review corrections, merge, production deployment,
verification and issue closure on 3 November 2026. The original PR head is
`b45abbd0712f1faa52ac7ffe82ab4124d9f1564a`, reviewed against fixed base
`b35968e596aa2b74aae2fbf765c1576041c1cc45`. Current main was merged before the
final integration checks. The upstream profile, feature-gate, import and SLA
changes are retained. No new schema migration or production feature-gate change
is needed for this calendar slice.

## Standards

Two concrete correctness findings were reproduced and corrected:

- P1: Invalid manual date drafts retained the previous canonical value. Non-form
  recurring saves and inbox snoozing could submit that earlier value. Explicit
  save/draft/submit actions now call the actual input's native validity check;
  advanced date-filter Apply actions validate their dialog's fields. Native call
  and loop forms retain browser validation.
- P2: Inline calendars used `defaultMonth`, so an externally changed selected
  date could leave the calendar showing another year. The displayed month now
  follows actual selected-date changes. Manual month navigation survives
  preference-only refreshes and time-only edits.

No separate documented-standard or heuristic-only issue was considered a release
blocker. Independent re-review found no remaining standards/correctness blocker.

## Spec

One P1 finding was shared with Standards: replacing native date controls must
preserve safe date/time behavior, including invalid visible input. The actual
recurring click and keyboard save paths and inbox Snooze action now reject the
stale-date operation. The calendar month correction also preserves selection
visibility when canonical values refresh. Independent re-review found no
remaining contract blocker.

The approved Sunday/Monday/Saturday presentation, live preference subscription,
hidden week numbers and unchanged ISO conventions remain intact. No date,
timezone, schedule, migration or feature-policy semantics are changed.

## Validation

Five new regression cases failed before correction: partial/impossible dates in
the actual recurring editor and inbox actions, plus an external cross-year
selection change. All 22 focused cases pass after correction, independently
rerun by both reviewers. The integrated app suite passes 2,685 tests in 341 files
(650 database-dependent cases skipped), plus four Workflow tests. TypeScript and
the complete production build including protected Workflow handlers pass. Lint
and formatting outcomes are recorded in the companion release evidence.

Production preflight verified `neondb` on `br-muddy-queen-zaeeysjt`, all 73 source
migration receipts including their hashes/timestamps, and the existing one
workspace/one user/14 receipts with no projects or issues. There is no migration
to apply. Production preference synchronization is already enabled. Production
rollout, public health, authenticated browser acceptance, fixture cleanup and
scoped error/fatal log results are appended only after verification.
