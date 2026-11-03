# PR #54 review and release

Original head: `dddf51ee7db85d493d17ff4399fbd463b20e560e`.
Review base: `7e8cd5c2662abebb876c22fc002bd557d120f76a`.
Corrected runtime: `965ae0f5541b0f61b5c3e73a672ba2fcc09a46a7`.

## Standards

One P2 correctness issue was fixed. A focus/timer refresh beginning during a
policy save could return afterward and overwrite the saved editor state with
an older snapshot. Refreshes now skip active mutations, and mutation boundaries
invalidate outstanding reads. Two editor regressions passed, including an
independent re-run by the reviewer. No documented-standard violations or
remaining material Standards findings were found.

## Spec

One P1 was fixed. Reopening after 30 days under a different creation-anchored
apply rule could produce an immediately obsolete deadline and replace the
promised saved duration/calendar. Reopen-specific reuse/reset now takes
precedence over apply-rule rematching on that transition. Explicit removal
still wins; later relevant edits follow ordinary ordered matching. A new actual
PostgreSQL command regression covers recent and 30-day reopens, changed rules,
creation anchoring and changed calendars; the reviewer independently reran it.
No remaining material Spec findings were found.

Totals: one finding per axis, both fixed. Worst priority: Standards P2; Spec P1.

## Verification before release

All 27 targeted checks passed: 21 real PostgreSQL tests, four admission/schema
tests and two editor concurrency tests. The app suite passed 2,662 tests in 338
files, with 650 environment-bound fixtures skipped; four Workflow tests passed.
Typecheck, build and protected Workflow verification passed. Changed-fix lint
has zero errors. FOR-42 and FOR-64 were independently rechecked as Done.

A normal Neon branch cloned current production data for migration rehearsal.
Branch `br-small-darkness-zahmr2fc` expires on 4 November 2026 at 13:30 UTC.
The serialized runner applied one migration, bringing its journal to 73; the
second run applied zero. Six browser scenarios then passed against that clone
with the built app and real Better Auth sessions. Device timezones and the
2040 device clock did not alter server deadlines. Fixture records were removed.

[Structured review evidence](review-evidence.json),
[rehearsal browser results](rehearsal-browser.json) and
[rehearsal screenshot](rehearsal-issue-sla.png) retain source/environment details.
Production execution evidence is recorded separately after the authorized
release; this pre-release record does not itself claim a production deployment.
